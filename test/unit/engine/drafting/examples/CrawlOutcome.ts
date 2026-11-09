// Shared setup for the engine tests of explore mode: the page map, the crawl and the static
// locator check.
//
//   - pageMapEntry(), crawlSite(), checkDraftLocators() and admitAsCoreRoute() call the engine's
//     functions, looked up at run time so these tests compile before the functions exist. A missing
//     export fails each test loudly, naming it. What they answer is outside these tests' types, so
//     it is decoded here (pageMapOf, crawlOutcomeOf, warningsOf) before any test reads it;
//   - fakeSite() is a site held in memory, keyed by absolute URL, and spyExploreDriver() is an
//     ExploreDriver over it that records every call made on it, including calls of methods it does
//     not have, such as act or runScript;
//   - followEveryLink() is a mutant crawl that follows every link it is given, on any origin, and
//     clicks the first button of every page. The negative tests run it to show their checks fail
//     against a crawl that does what the spec forbids.
//
// What these tests assume about shapes the spec leaves open, gathered here so a change to one is a
// change to this file only:
//   - crawlSite(driver, project, options) is called with the spec's three arguments, and the
//     project's redactor fourth: the build notes do not say where the crawl's redactor comes from,
//     and a function that takes three arguments ignores the fourth;
//   - a navigate step whose URL is a path ("Go to /contact") is on the page map's origin, as a run
//     resolves it against its base URL;
//   - checkDraftLocators names a warning's line in its position; the column is not checked;
//   - ExploreOptions spells out the spec's maxPages, maxDepth and pageTimeoutMs as maximumPages,
//     maximumDepth and pageTimeoutMilliseconds, as the naming lint requires of every identifier.
import assert from 'node:assert/strict';
import {
  defaultRedactor, failure, success,
  type A11yNode, type DriverError, type PageProbe, type PageReadFailure, type PageReadFailureCode, type Plan, type Redactor, type Result, type TextReading, type TrustedProject,
} from '@revisum/engine';
import { scriptsEnabled } from '#test-support/browser/ScriptsEnabled.ts';
import { fakeExploreDriver } from '#test-support/fakes/session/FakeExploreDriver.ts';
import { DriverErrorCode } from '@revisum/contracts';

// ---- The types the spec names, as these tests read them --------------------------------------------

export type PageMapNode = { readonly role: string; readonly name: string; readonly children: readonly PageMapNode[] };
export type PageMapEntry = { readonly path: string; readonly title: string; readonly depth: number; readonly tree: readonly PageMapNode[] };
export type PageMap = {
  readonly origin: string;
  readonly pages: readonly PageMapEntry[];
  readonly truncated: boolean;
  readonly guaranteeLevel: 'isolated' | 'host';
};
export type ExploreOptions = {
  readonly start: string;
  readonly maximumPages: number;
  readonly maximumDepth: number;
  readonly pageTimeoutMilliseconds: number;
  readonly placement: 'isolated' | 'host';
};
// The driver port the crawl is given (contracts' ExploreDriver in the build notes).
export type ExploreDriver = {
  navigate(url: string, options: { readonly scripts: 'enabled' | 'disabled' }): Promise<Result<void, DriverError>>;
  page(): Promise<Result<PageProbe, PageReadFailure>>;
  accessibilitySnapshot(): Promise<Result<A11yNode, PageReadFailure>>;
  linkTargets(): Promise<Result<readonly string[], PageReadFailure>>;
};
export type CrawlOutcome = { readonly ok: true; readonly map: PageMap } | { readonly ok: false; readonly code: string };
export type LineWarning = { readonly code: string; readonly line: number };

// The kept roles, as the build notes list them.
export const KEPT_ROLES = [
  'banner', 'main', 'navigation', 'contentinfo', 'complementary', 'region', 'search', 'form', 'heading', 'link', 'button', 'textbox',
  'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'list', 'listitem', 'table',
  'row', 'cell', 'columnheader', 'rowheader', 'dialog', 'alertdialog', 'tab', 'tablist', 'tabpanel', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio',
] as const;
// Roles a browser reports that the page map drops: text content, wrappers and the document itself.
export const DROPPED_ROLES = [
  'document', 'RootWebArea', 'StaticText', 'InlineTextBox', 'paragraph', 'generic', 'group', 'image', 'img', 'LabelText', 'label',
  'ListMarker', 'rowgroup', 'none', 'presentation', 'article', 'figure', 'code', 'emphasis', 'strong', 'blockquote', 'separator',
] as const;

export const MAXIMUM_NAME_LENGTH = 80;
export const DEFAULT_OPTIONS = { maximumPages: 20, maximumDepth: 3, pageTimeoutMilliseconds: 15_000, placement: 'host' } as const;

// ---- Looking up and decoding the engine's functions --------------------------------------------------

async function engineFunction(name: string): Promise<(...inputs: readonly unknown[]) => unknown> {
  const loaded: unknown = await import('@revisum/engine');
  const exported: unknown = typeof loaded === 'object' && loaded !== null ? Object.getOwnPropertyDescriptor(loaded, name)?.value : undefined;
  if (typeof exported !== 'function') throw new Error(`@revisum/engine does not export a function named ${name}`);
  return (...inputs): unknown => {
    const answer: unknown = Reflect.apply(exported, undefined, inputs);
    return answer;
  };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function pageMapNodesOf(value: unknown, where = 'tree'): readonly PageMapNode[] {
  assert.ok(Array.isArray(value), `${where} is not a list: ${JSON.stringify(value)}`);
  return value.map((node: unknown, index: number): PageMapNode => {
    assert.ok(isRecord(node), `${where}[${index}] is not an object`);
    assert.deepEqual(Object.keys(node).sort(), ['children', 'name', 'role'], `${where}[${index}] has other fields than role, name and children`);
    const { role, name } = node;
    assert.ok(typeof role === 'string' && typeof name === 'string', `${where}[${index}] has no text role or name`);
    return { role, name, children: pageMapNodesOf(node['children'], `${where}[${index}].children`) };
  });
}

export function pageMapEntryOf(value: unknown, where = 'entry'): PageMapEntry {
  assert.ok(isRecord(value), `${where} is not an object: ${JSON.stringify(value)}`);
  assert.deepEqual(Object.keys(value).sort(), ['depth', 'path', 'title', 'tree'], `${where} has other fields than path, title, depth and tree`);
  const { path, title, depth } = value;
  assert.ok(typeof path === 'string' && typeof title === 'string' && typeof depth === 'number', `${where} has a wrong field type`);
  return { path, title, depth, tree: pageMapNodesOf(value['tree'], `${where}.tree`) };
}

export function pageMapOf(value: unknown): PageMap {
  assert.ok(isRecord(value), `the page map is not an object: ${JSON.stringify(value)}`);
  assert.deepEqual(Object.keys(value).sort(), ['guaranteeLevel', 'origin', 'pages', 'truncated'], 'the page map has other fields');
  const { origin, truncated, guaranteeLevel } = value;
  const pages = value['pages'];
  assert.ok(typeof origin === 'string' && typeof truncated === 'boolean', 'the page map has a wrong field type');
  assert.ok(guaranteeLevel === 'isolated' || guaranteeLevel === 'host', `the guarantee level is ${String(guaranteeLevel)}`);
  assert.ok(Array.isArray(pages), 'the page map has no list of pages');
  return { origin, truncated, guaranteeLevel, pages: pages.map((page: unknown, index: number) => pageMapEntryOf(page, `pages[${index}]`)) };
}

function crawlOutcomeOf(value: unknown): CrawlOutcome {
  assert.ok(isRecord(value) && typeof value['ok'] === 'boolean', `crawlSite did not answer with a result: ${JSON.stringify(value)}`);
  if (value['ok']) return { ok: true, map: pageMapOf(value['value']) };
  const error = value['error'];
  assert.ok(isRecord(error) && typeof error['code'] === 'string', `crawlSite failed without a code: ${JSON.stringify(value)}`);
  return { ok: false, code: error['code'] };
}

export async function pageMapEntry(tree: A11yNode, url: string, title: string, depth: number, redact: Redactor): Promise<PageMapEntry> {
  const build = await engineFunction('pageMapEntry');
  return pageMapEntryOf(build(tree, url, title, depth, redact));
}

export async function crawlSite(
  driver: ExploreDriver, project: TrustedProject, options: ExploreOptions, redactor: Redactor = defaultRedactor(),
): Promise<CrawlOutcome> {
  const crawl = await engineFunction('crawlSite');
  return crawlOutcomeOf(await crawl(driver, project, options, redactor));
}

export async function checkDraftLocators(plan: Plan, reading: TextReading, map: PageMap): Promise<readonly LineWarning[]> {
  const check = await engineFunction('checkDraftLocators');
  const warnings: unknown = check(plan, reading, map);
  assert.ok(Array.isArray(warnings), `checkDraftLocators did not answer with a list: ${JSON.stringify(warnings)}`);
  return warnings.map((warning: unknown): LineWarning => {
    assert.ok(isRecord(warning) && typeof warning['code'] === 'string', `a warning has no code: ${JSON.stringify(warning)}`);
    const position = warning['position'];
    assert.ok(isRecord(position) && typeof position['line'] === 'number', `a warning has no line: ${JSON.stringify(warning)}`);
    return { code: warning['code'], line: position['line'] };
  });
}

// Every node of a tree, depth first, in order.
export const allNodes = (tree: readonly PageMapNode[]): readonly PageMapNode[] => tree.flatMap((node) => [node, ...allNodes(node.children)]);

// ---- A site held in memory --------------------------------------------------------------------------

export type FakePage = {
  readonly title: string;
  // Absolute URLs, as the driver's linkTargets gives them.
  readonly links: readonly string[];
  // The page's accessibility tree; a document with one heading, the title, unless given.
  readonly tree?: A11yNode;
  // A page that does not load: navigate answers navigation-failed.
  readonly fails?: true;
  // A page that loads and that one of a crawl's reads then gets nothing from.
  readonly failingRead?: { readonly read: PageRead; readonly code: PageReadFailureCode };
};
export type PageRead = 'page' | 'accessibilitySnapshot' | 'linkTargets';
export type FakeSite = ReadonlyMap<string, FakePage>;

// A site from pages keyed by absolute URL without query or fragment.
export const fakeSite = (pages: Readonly<Record<string, FakePage>>): FakeSite => new Map(Object.entries(pages));

const headingTree = (title: string): A11yNode => ({
  role: 'document', name: title, children: [{ role: 'main', name: '', children: [{ role: 'heading', name: title, children: [] }] }],
});

// The site's page for a URL, ignoring its query and fragment, as a server would.
const pageAt = (site: FakeSite, url: string): FakePage | undefined => {
  const parsed = new URL(url);
  return site.get(`${parsed.origin}${parsed.pathname}`);
};

// What a read of the current page gives: what it shows, unless that read is the page's failing one.
const readOfPage = <Value>(read: PageRead, page: FakePage | undefined, shown: Value): Result<Value, PageReadFailure> =>
  page?.failingRead?.read === read
    ? failure({ code: page.failingRead.code, detail: `the fake site's ${read} failed` })
    : success(shown);

// One call made on the spy driver: the method's name and, for navigate, the URL.
export type DriverCall = { readonly method: string; readonly url?: string };

export type SpyExploreDriver = { readonly driver: ExploreDriver; readonly calls: readonly DriverCall[]; readonly navigations: () => readonly string[] };

// An ExploreDriver over the fake site that records every call made on it. A method the port does
// not have, such as act, probe or runScript, is recorded too, and answers nothing.
export function spyExploreDriver(site: FakeSite): SpyExploreDriver {
  const calls: DriverCall[] = [];
  let current: { readonly url: string; readonly page: FakePage } | undefined;
  const driver = fakeExploreDriver({
    async navigate(url) {
      calls.push({ method: 'navigate', url });
      const page = pageAt(site, url);
      if (page === undefined || page.fails === true) return failure({ code: DriverErrorCode.NavigationFailed, detail: `no page at ${url}` });
      current = { url, page };
      return success(undefined);
    },
    async page() {
      calls.push({ method: 'page' });
      return readOfPage('page', current?.page, { url: current?.url ?? 'about:blank', title: current?.page.title ?? '', meta: [], canonicalUrl: null });
    },
    async accessibilitySnapshot() {
      calls.push({ method: 'accessibilitySnapshot' });
      return readOfPage('accessibilitySnapshot', current?.page, current === undefined ? { role: 'document', name: '', children: [] } : current.page.tree ?? headingTree(current.page.title));
    },
    async linkTargets() {
      calls.push({ method: 'linkTargets' });
      return readOfPage('linkTargets', current?.page, current?.page.links ?? []);
    },
  });
  const spy = new Proxy(driver, {
    get(target, property, receiver) {
      const own: unknown = Reflect.get(target, property, receiver);
      if (typeof property !== 'string' || property === 'then' || Object.hasOwn(target, property)) return own;
      return (...inputs: readonly unknown[]) => {
        calls.push({ method: property });
        return Promise.resolve(success(inputs.length));
      };
    },
  });
  return {
    driver: spy,
    calls,
    navigations: () => calls.flatMap((call) => (call.method === 'navigate' && call.url !== undefined ? [call.url] : [])),
  };
}

// The calls a crawl may make: navigation and reads only.
export const CRAWL_METHODS: readonly string[] = ['navigate', 'page', 'accessibilitySnapshot', 'linkTargets'];

// The mutant: a crawl that follows every link on any origin, and clicks a button on every page.
export async function followEveryLink(driver: ExploreDriver, start: string, maximumPages: number): Promise<void> {
  const queue = [start];
  const seen = new Set(queue);
  for (let visited = 0; visited < maximumPages && queue.length > 0; visited++) {
    const url = queue.shift();
    if (url === undefined) break;
    const navigated = await driver.navigate(url, scriptsEnabled);
    if (!navigated.ok) continue;
    const act: unknown = Reflect.get(driver, 'act');
    if (typeof act === 'function') await Reflect.apply(act, driver, [{ type: 'click', locator: { by: 'role', role: 'button', name: 'Send' } }]);
    const links = await driver.linkTargets();
    for (const link of links.ok ? links.value : []) {
      if (!seen.has(link)) { seen.add(link); queue.push(link); }
    }
  }
}

// ---- The project the crawl tests use ------------------------------------------------------------

export const START_ORIGIN = 'http://127.0.0.1:4310';
// Declared, not production, and still never crawled from the start origin.
export const SECOND_ORIGIN = 'http://127.0.0.1:4311';
// Declared, and production.
export const PRODUCTION_ORIGIN = 'https://shop.example.com';
// Not declared at all.
export const UNDECLARED_ORIGIN = 'http://127.0.0.1:4399';

export const crawlProjectFile = () => ({
  origins: [START_ORIGIN, SECOND_ORIGIN, PRODUCTION_ORIGIN],
  productionOrigins: [PRODUCTION_ORIGIN],
  matrix: [{
    id: 'explore-chromium', adapter: 'cdp', engine: 'chromium', device: 'desktop-1280', locale: 'en-GB',
    timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
  }],
});

export const at = (path: string, origin: string = START_ORIGIN): string => `${origin}${path}`;
export const optionsFor = (start: string, bounds: Partial<Pick<ExploreOptions, 'maximumPages' | 'maximumDepth'>> = {}): ExploreOptions =>
  ({ ...DEFAULT_OPTIONS, start, ...bounds });
