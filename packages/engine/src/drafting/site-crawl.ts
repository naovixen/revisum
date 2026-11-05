// The crawl behind the draft command's explore mode: deterministic, with no AI, and with the
// browser session injected. It starts at the given URL, which must be on a declared origin that is
// not a production one, and only navigates and reads: each page's title, accessibility tree and
// link targets. It never clicks, types, selects, submits or runs a script of its own.
//
// Pages are visited breadth first from the start page at depth 0. A page's link targets are kept
// when they are on the start origin; each is reduced to its path (no query or fragment),
// de-duplicated against every path already seen, and queued in sorted order, so the same site gives
// the same map whatever order its links come in. Pages are opened at origin plus path. A page other
// than the start page that does not load is left out and not counted; a start page that does not
// load stops the crawl. A page that loaded and then cannot be read, because a dialog holds it, the
// browser has died or it does not answer, is treated the same, with nothing of it kept, and the map
// then says it is truncated: unlike a page that never loaded, this one is there and the map lacks
// it, and its links with it. The next navigate ends any dialog. `truncated` also says whether a page
// on the start origin was left unvisited because of maximumPages or maximumDepth.
import {
  failure, NavigateScripts, success,
  type A11yNode, type CrawlErrorCode, type ExploreDriver, type ExploreOptions, type Origin, type PageMap, type PageMapEntry, type PageReadFailure, type Redactor, type Result,
} from '@revisum/contracts';
import { defaultRedactor } from '../redaction.ts';
import { MAXIMUM_EXPLORE_DEPTH, MAXIMUM_EXPLORE_PAGES, pageMapEntry } from './page-map.ts';

// The bounds a crawl has unless the person asks for others.
export const DEFAULT_EXPLORE_PAGES = 20;
export const DEFAULT_EXPLORE_DEPTH = 3;
export const DEFAULT_PAGE_TIMEOUT_MILLISECONDS = 15_000;

// What a crawl needs of the trusted project: where it may go.
type CrawlProject = { readonly origins: readonly Origin[]; readonly productionOrigins: readonly Origin[] };

// The declared origin a crawl may start from at this URL, or undefined when it may not start
// there: a URL that is not http or https, carries credentials, or is on an origin the project does
// not declare or declares as production.
export function exploreStartOrigin(project: CrawlProject, start: string): Origin | undefined {
  let url: URL;
  try {
    url = new URL(start);
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username !== '' || url.password !== '') return undefined;
  if (project.productionOrigins.some((origin) => origin === url.origin)) return undefined;
  return project.origins.find((origin) => origin === url.origin);
}

const clamp = (value: number, lowest: number, highest: number): number =>
  (Number.isInteger(value) ? Math.min(Math.max(value, lowest), highest) : lowest);

// True when the navigation loaded within the time allowed. A navigation still running at the end
// is left to finish on its own; the page counts as not loaded.
async function loadedInTime(driver: ExploreDriver, url: string, timeoutMilliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMilliseconds); });
  try {
    const navigated = driver.navigate(url, { scripts: NavigateScripts.Enabled }).then((outcome) => outcome.ok, () => false);
    return await Promise.race([navigated, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

// The path of a link target on the origin, or undefined for one elsewhere or not a URL at all.
function sameOriginPath(target: string, origin: Origin): string | undefined {
  try {
    const url = new URL(target);
    return url.origin === origin ? url.pathname : undefined;
  } catch {
    return undefined;
  }
}

type Queued = { readonly path: string; readonly depth: number };
type LoadedPage = { readonly title: string; readonly tree: A11yNode; readonly linkTargets: readonly string[] };

// What a crawl keeps of the page it has loaded, all of it or none; undefined for a redirect off the
// origin, which counts as a page that did not load and is read no further.
async function readLoadedPage(driver: ExploreDriver, origin: Origin): Promise<Result<LoadedPage | undefined, PageReadFailure>> {
  const shown = await driver.page();
  if (!shown.ok) {
    return shown;
  }
  if (sameOriginPath(shown.value.url, origin) === undefined) {
    return success(undefined);
  }
  const tree = await driver.accessibilitySnapshot();
  if (!tree.ok) {
    return tree;
  }
  const linkTargets = await driver.linkTargets();
  if (!linkTargets.ok) {
    return linkTargets;
  }
  return success({ title: shown.value.title, tree: tree.value, linkTargets: linkTargets.value });
}

export async function crawlSite(
  driver: ExploreDriver, project: CrawlProject, options: ExploreOptions, redactor: Redactor = defaultRedactor(),
): Promise<Result<PageMap, { readonly code: CrawlErrorCode }>> {
  // Refused before any driver call.
  const origin = exploreStartOrigin(project, options.start);
  if (origin === undefined) return failure({ code: 'explore-origin-refused' });
  const maximumPages = clamp(options.maximumPages, 1, MAXIMUM_EXPLORE_PAGES);
  const maximumDepth = clamp(options.maximumDepth, 0, MAXIMUM_EXPLORE_DEPTH);
  const pageTimeout = Math.max(options.pageTimeoutMilliseconds, 1);

  const startPath = new URL(options.start).pathname;
  const queue: Queued[] = [{ path: startPath, depth: 0 }];
  const seen = new Set<string>([startPath]);
  const pages: PageMapEntry[] = [];
  let truncated = false;

  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    if (pages.length >= maximumPages) { truncated = true; break; }
    const url = `${origin}${next.path}`;
    const read = await loadedInTime(driver, url, pageTimeout) ? await readLoadedPage(driver, origin) : success(undefined);
    if (!read.ok || read.value === undefined) {
      if (next.depth === 0) return failure({ code: 'explore-start-unreachable' });
      truncated ||= !read.ok;
      continue;
    }
    pages.push(pageMapEntry(read.value.tree, url, read.value.title, next.depth, redactor));
    const found = new Set<string>();
    for (const target of read.value.linkTargets) {
      const path = sameOriginPath(target, origin);
      if (path !== undefined && !seen.has(path)) found.add(path);
    }
    for (const path of [...found].sort()) {
      if (next.depth + 1 > maximumDepth) { truncated = true; continue; }
      seen.add(path);
      queue.push({ path, depth: next.depth + 1 });
    }
  }
  return success({ origin, pages, truncated, guaranteeLevel: options.placement });
}
