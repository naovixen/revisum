// The crawl of the draft command's explore mode, as the run container runs it: started by
// explore-crawl.ts through RunnerHandle.exec, never by a person. Its one argument is the
// ContainerCrawlInput as JSON. It reads the project, clears the --after plan through the policy
// gate again, opens a headless Chromium through the CDP driver behind the run's egress proxy
// (HTTP_PROXY), runs the plan, crawls, and prints the page map as canonical JSON on standard
// output. Secrets come from its environment, where the runner copied them by name.
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  defaultRedactor, environmentSecretStore, exploreStartOrigin, pageMapText, parseProject, planParser, policyGate, readPlanText, success,
  withDeclaredSecretRedaction, type EventSink, type Project,
} from '@revisum/engine';
import { buildAdapters } from './BuildAdapters.ts';
import { CONTAINER_EXIT, crawlInBrowser, crawlTarget, decodeContainerCrawlInput, type BrowserCrawl } from './explore-crawl.ts';

// Where the run image keeps the pinned Chrome for Testing builds, relative to the working folder.
const BROWSER_CACHE = join('.browsers', 'chrome');

// The pinned Chrome for Testing for Linux, as the browser installer lays it out; the newest build
// when there are several.
function pinnedChrome(): string | undefined {
  let builds: string[];
  try {
    builds = readdirSync(BROWSER_CACHE).filter((folder) => folder.startsWith('linux-')).sort();
  } catch {
    return undefined;
  }
  const newest = builds.at(-1);
  return newest === undefined ? undefined : join(BROWSER_CACHE, newest, 'chrome-linux64', 'chrome');
}

// The container keeps no audit log of its own: the host recorded the gate's decision already.
const discardingAudit: EventSink = { append: () => success({ sequence: 0 }) };

function stop(code: number, reason: string): number {
  process.stderr.write(`${reason}\n`);
  return code;
}

// The --after plan, cleared by the policy gate for the crawl's target, or undefined when it is refused.
function clearedLogin(text: string, project: Project, target: BrowserCrawl['target']): BrowserCrawl['login'] | undefined {
  const read = readPlanText(text, project.limits);
  if (!read.ok) return undefined;
  const parsed = planParser(project)(read.value.json);
  if (!parsed.ok || !parsed.value.targets.includes(target.id)) return undefined;
  // The host checked the approval; here the plan runs as the proposal it is to the container.
  const decision = policyGate({ project, events: discardingAudit }).clear(parsed.value, target.id);
  return decision.kind === 'allow' ? decision.run : undefined;
}

async function main(): Promise<number> {
  let given: unknown;
  try {
    given = JSON.parse(process.argv[2] ?? '');
  } catch {
    return stop(CONTAINER_EXIT.failed, 'the crawl input is not JSON');
  }
  const input = decodeContainerCrawlInput(given);
  if (input === undefined) return stop(CONTAINER_EXIT.failed, 'the crawl input is not a crawl input');
  const project = parseProject(input.project);
  if (!project.ok) return stop(CONTAINER_EXIT.failed, 'the project is not a valid project');
  const target = crawlTarget(project.value);
  if (target === undefined || exploreStartOrigin(project.value, input.start) === undefined) return stop(CONTAINER_EXIT.failed, 'nothing may be crawled');
  const browserPath = input.browserPath ?? pinnedChrome();
  if (browserPath === undefined) return stop(CONTAINER_EXIT.failed, 'no browser is installed');
  const proxyServer = process.env['HTTP_PROXY'];
  if (proxyServer === undefined || proxyServer === '') {
    return stop(CONTAINER_EXIT.failed, 'HTTP_PROXY is unset or empty, so the crawl has no egress proxy to run behind');
  }

  // Only the declared secrets are read from the environment.
  const variables = Object.fromEntries(project.value.secretNames.map((name) => [name, process.env[name]]));
  const secrets = environmentSecretStore(variables);
  const redactor = withDeclaredSecretRedaction(defaultRedactor(), project.value.secretNames, secrets);
  let login: BrowserCrawl['login'];
  if (input.afterPlan !== undefined) {
    login = clearedLogin(input.afterPlan, project.value, target);
    if (login === undefined) return stop(CONTAINER_EXIT.loginRefused, 'the --after plan was refused');
  }

  const browser = buildAdapters.containerBrowserDriver({ executablePath: browserPath, proxyServer });
  const crawled = await crawlInBrowser(browser, {
    project: project.value, target, redactor, secrets, audit: discardingAudit,
    options: {
      start: input.start, maximumPages: input.maximumPages, maximumDepth: input.maximumDepth,
      pageTimeoutMilliseconds: input.pageTimeoutMilliseconds, placement: 'isolated',
    },
    ...(login === undefined ? {} : { login }),
  });
  if (!crawled.ok) {
    if (crawled.error === 'explore-start-unreachable') return stop(CONTAINER_EXIT.startUnreachable, crawled.error);
    if (crawled.error === 'plan-rejected') return stop(CONTAINER_EXIT.loginRefused, crawled.error);
    return stop(CONTAINER_EXIT.failed, crawled.error);
  }
  process.stdout.write(pageMapText(crawled.value));
  return CONTAINER_EXIT.mapped;
}

if (import.meta.main) process.exitCode = await main();
