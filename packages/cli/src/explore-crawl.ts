// Where the draft command's explore mode crawls: in a browser session on the host (--host), or in
// the isolated runner's run container, whose egress proxy lets the browser reach the start origin
// alone. Either way the crawl itself is the engine's crawlSite, which only navigates and reads.
//
// An approved --after plan, such as a login, runs first in the crawl's own session, so the crawl
// sees what a signed-in person sees. It runs through the engine's normal run path, already cleared
// by the policy gate, writing no result file, through the login runner the composition root hands in.
//
// In the run container the crawl is this package's explore-in-container.ts, started through
// RunnerHandle.exec. Secrets reach it by variable name only, never on its command line, and the
// page map it prints is outside data: the host decodes it with the engine's decodePageMap.
import { arch, platform } from 'node:os';
import {
  baseUrlOfOrigin, crawlSite, decodePageMap, exploreStartOrigin, failure, redactPageMap, success,
  type BrowserDriver, type ClearedRun, type ClosedSession, type EventSink, type ExploreDriver, type ExploreOptions,
  type ImageDigest, type Origin, type PageMap, type Project, type Redactor, type Result, type RunInputs, type RunResult,
  type Runner, type RunnerHandle, type SecretName, type SecretStore, type Session, type Target,
  type VariableName,
} from '@revisum/engine';
import { buildEgressPolicy, readVariableName } from '@revisum/runner';

// Why a crawl stopped, as the command reports it.
// target-unavailable: the browser did not open.
// plan-rejected: the --after plan did not pass, so the pages would not be the signed-in ones.
// explore-crawl-crashed: the crawl started in the run container and ended with a failure of its own.
export type CrawlStop =
  | 'explore-origin-refused' | 'explore-start-unreachable' | 'explore-runner-unavailable' | 'explore-crawl-crashed' | 'target-unavailable' | 'plan-rejected';

// What a crawl in a browser found or why it stopped, and what its session's close said. The close says
// nothing of the pages, so the crawl's outcome stands whatever it was; it is carried to the command's
// output so that a browser left running, or a profile still held, is not lost.
export type BrowserCrawlOutcome = Result<PageMap, CrawlStop> & { readonly closeFailure: string | null };
const stoppedBeforeTheSession = (stop: CrawlStop): BrowserCrawlOutcome => ({ ...failure(stop), closeFailure: null });

// One crawl in a browser session: the bounds, how text read from pages is redacted, and either the
// gate-cleared --after run, whose project and target the crawl's session is, or, with no --after
// run, the project the crawl may go to and the target its session opens. A login cleared for one
// project or target cannot be handed a session opened for another.
export type BrowserCrawl = {
  readonly options: ExploreOptions;
  readonly redactor: Redactor;
  readonly secrets: SecretStore;
  // Where the --after run's policy denials are recorded.
  readonly audit: EventSink;
} & ({ readonly login: ClearedRun; readonly runLogin: LoginRunner } | { readonly project: Project; readonly target: Target });

// What a login run needs of the crawl's session, which it shares.
export type LoginRun = {
  readonly browser: BrowserDriver;
  readonly session: Session;
  readonly redactor: Redactor;
  readonly secrets: SecretStore;
  readonly audit: EventSink;
};

// Runs a cleared --after plan in the crawl's own session, leaving it open.
export type LoginRunner = (login: ClearedRun, onSession: LoginRun, inputs: RunInputs) => Promise<RunResult>;

// The page's random numbers are seeded, so a page that uses them shows the same each time.
const CRAWL_SEED = 0;

// The target a crawl opens its session on: the project's first Chromium target, since the crawl
// reads pages through the CDP driver.
export const crawlTarget = (project: Project): Target | undefined => project.matrix.find((target) => target.engine === 'chromium');

// Longer than a driver's stop takes to give up by itself, so this deadline is only for what has wedged.
const SESSION_CLOSE_DEADLINE_MILLISECONDS = 60_000;

// What closing the session said, or, when it never answered within the deadline, that it did not.
async function closeByTheDeadline(session: Session): Promise<ClosedSession | { readonly closeFailure: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ readonly closeFailure: string }>((resolve) => {
    timer = setTimeout(() => resolve({ closeFailure: `the browser session did not close within ${SESSION_CLOSE_DEADLINE_MILLISECONDS} ms` }), SESSION_CLOSE_DEADLINE_MILLISECONDS);
  });
  const closed = await Promise.race([session.close(), deadline]);
  clearTimeout(timer);
  return closed;
}

// The project and target the crawl's session is for: the --after run's own when there is one.
const sessionFor = (crawl: BrowserCrawl): { readonly project: Project; readonly target: Target } =>
  ('login' in crawl ? crawl.login : crawl);

export async function crawlInBrowser(browser: BrowserDriver, crawl: BrowserCrawl): Promise<BrowserCrawlOutcome> {
  const { project, target } = sessionFor(crawl);
  const origin = exploreStartOrigin(project, crawl.options.start);
  if (origin === undefined) {return stoppedBeforeTheSession('explore-origin-refused');}
  if (!browser.supports(target).ok) {return stoppedBeforeTheSession('target-unavailable');}
  const fixedTimeMilliseconds = Date.now();
  // The session may reach the start origin and nothing else.
  const baseUrl = baseUrlOfOrigin(origin);
  const opened = await browser.open(target, {
    baseUrl, allowedOrigins: [origin], seed: CRAWL_SEED, fixedTimeMilliseconds,
    sensitiveSelectors: crawl.redactor.selectors, timeoutMilliseconds: project.limits.stepTimeoutMilliseconds,
  });
  if (!opened.ok) {return stoppedBeforeTheSession('target-unavailable');}
  const session = opened.value;
  let crawled: Result<PageMap, CrawlStop>;
  try {
    crawled = await crawlOpenSession(session, browser, crawl, { baseUrl, fixedTimeMilliseconds });
  } catch (error) {
    const { closeFailure } = await closeByTheDeadline(session);
    if (closeFailure === null) {
      throw error;
    }
    throw new Error(`${error instanceof Error ? error.message : String(error)}; the crawl's session also did not close: ${closeFailure}`, { cause: error });
  }
  const { closeFailure } = await closeByTheDeadline(session);
  return { ...crawled, closeFailure };
}

// What a crawl's --after run needs of the session it shares.
type CrawlOfASession = {
  readonly baseUrl: ReturnType<typeof baseUrlOfOrigin>;
  readonly fixedTimeMilliseconds: number;
};

// The --after run, if there is one, and the crawl, on the session that is open already.
async function crawlOpenSession(
  session: Session, browser: BrowserDriver, crawl: BrowserCrawl, opened: CrawlOfASession,
): Promise<Result<PageMap, CrawlStop>> {
  const { project } = sessionFor(crawl);
  const { baseUrl, fixedTimeMilliseconds } = opened;
  if ('login' in crawl) {
    const loggedIn = await crawl.runLogin(crawl.login, { browser, session, redactor: crawl.redactor, secrets: crawl.secrets, audit: crawl.audit }, {
      baseUrl, seed: CRAWL_SEED, fixedTimeMilliseconds, fixtures: [], host: { platform: platform(), arch: arch() },
    });
    if (loggedIn.state !== 'Passed') {return failure('plan-rejected');}
  }
  // Navigation and reads only: nothing else of the session is in reach of the crawl.
  const explorer: ExploreDriver = {
    navigate: (url, navigation) => session.navigate(url, navigation),
    page: () => session.page(),
    accessibilitySnapshot: () => session.accessibilitySnapshot(),
    linkTargets: () => session.linkTargets(),
  };
  const crawled = await crawlSite(explorer, project, crawl.options, crawl.redactor);
  return crawled.ok ? crawled : failure(crawled.error.code);
}

// ---- The crawl in the run container ----------------------------------------------------------------

// The entry module the run container starts, relative to its working folder.
export const CONTAINER_CRAWL_MODULE = 'packages/cli/src/explore-in-container.ts';
// How the entry module ends: with the page map printed, or why there is none.
export const CONTAINER_EXIT = { mapped: 0, failed: 1, startUnreachable: 3, loginRefused: 4 } as const;

// What the host hands the entry module, as one JSON argument. It holds the protected project.json
// as written, the bounds and the --after plan's text, which names secrets but never holds one.
export type ContainerCrawlInput = {
  readonly project: unknown;
  readonly start: string;
  readonly maximumPages: number;
  readonly maximumDepth: number;
  readonly pageTimeoutMilliseconds: number;
  readonly afterPlan?: string;
  // The browser inside the container; the pinned Chrome for Testing under .browsers unless given.
  readonly browserPath?: string;
};

export type IsolatedRunner = { readonly runner: Runner; readonly image: ImageDigest; readonly browserPath?: string };

// The input the entry module was given, or undefined when it is not one.
export function decodeContainerCrawlInput(value: unknown): ContainerCrawlInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {return undefined;}
  const fields: Readonly<Record<string, unknown>> = { ...value };
  const { start, maximumPages, maximumDepth, pageTimeoutMilliseconds, afterPlan, browserPath } = fields;
  if (typeof start !== 'string' || typeof maximumPages !== 'number' || typeof maximumDepth !== 'number' || typeof pageTimeoutMilliseconds !== 'number') {return undefined;}
  if ((afterPlan !== undefined && typeof afterPlan !== 'string') || (browserPath !== undefined && typeof browserPath !== 'string')) {return undefined;}
  return {
    project: fields['project'], start, maximumPages, maximumDepth, pageTimeoutMilliseconds,
    ...(afterPlan === undefined ? {} : { afterPlan }), ...(browserPath === undefined ? {} : { browserPath }),
  };
}

// Starts a run container whose egress reaches the start origin alone, crawls inside it, and
// decodes the page map it prints. A runner that cannot start or cannot enforce egress gives
// explore-runner-unavailable, with nothing crawled; a crawl that ran and crashed gives
// explore-crawl-crashed. The container is removed either way, by the run's own end.
export async function crawlInRunner(
  isolated: IsolatedRunner, input: ContainerCrawlInput, origin: Origin, secretNames: readonly SecretName[], redactor: Redactor,
): Promise<Result<PageMap, CrawlStop>> {
  const policy = buildEgressPolicy({ allowOrigins: [origin], allowServices: [] });
  if (!policy.ok) {return failure('explore-runner-unavailable');}
  const variableNames = secretNames.map(readVariableName);
  if (variableNames.includes(null)) {return failure('explore-runner-unavailable');}
  const crawled = await isolated.runner.withRun(isolated.image, policy.value, (run) =>
    crawlInRun(run, isolated, input, origin, variableNames.filter((name) => name !== null), redactor));
  if (!crawled.ok) {return failure('explore-runner-unavailable');}
  // Read after the run's end, so this says whether all of the crawl's egress was recorded.
  const isStillIsolated = crawled.value.final.guaranteeLevel === 'isolated';
  return isStillIsolated ? crawled.value.value : failure('explore-runner-unavailable');
}

// The crawl inside a run that has started, to the end of what its exit status says.
async function crawlInRun(
  run: RunnerHandle, isolated: IsolatedRunner, input: ContainerCrawlInput, origin: Origin, variableNames: readonly VariableName[], redactor: Redactor,
): Promise<Result<PageMap, CrawlStop>> {
  if (run.guaranteeLevel() !== 'isolated') {return failure('explore-runner-unavailable');}
  const given: ContainerCrawlInput = isolated.browserPath === undefined ? input : { ...input, browserPath: isolated.browserPath };
  const executed = await run.exec(['node', CONTAINER_CRAWL_MODULE, JSON.stringify(given)], variableNames);
  if (!executed.ok) {return failure('explore-runner-unavailable');}
  const outcome = executed.value;
  if (outcome.exitCode === CONTAINER_EXIT.startUnreachable) {return failure('explore-start-unreachable');}
  if (outcome.exitCode === CONTAINER_EXIT.loginRefused) {return failure('plan-rejected');}
  if (outcome.exitCode !== CONTAINER_EXIT.mapped) {return failure('explore-crawl-crashed');}
  let printed: unknown;
  try {
    printed = JSON.parse(outcome.stdout);
  } catch {
    return failure('explore-runner-unavailable');
  }
  const decoded = decodePageMap(printed, origin);
  if (!decoded.ok || decoded.value.guaranteeLevel !== 'isolated') {return failure('explore-runner-unavailable');}
  // Redacted again on the host, in case the container lacked a secret's value.
  return success(redactPageMap(decoded.value, redactor));
}
