// Where the draft command's explore mode crawls: in a browser session on the host (--host), or in
// the isolated runner's run container, whose egress proxy lets the browser reach the start origin
// alone. Either way the crawl itself is the engine's crawlSite, which only navigates and reads.
//
// An approved --after plan, such as a login, runs first in the crawl's own session, so the crawl
// sees what a signed-in person sees. It runs through the engine's normal run path, already cleared
// by the policy gate, writing no result file. This module is the one place in the draft command
// that may call the run function, and only for that plan: draft-command.ts stays route code.
//
// In the run container the crawl is this package's explore-in-container.ts, started through
// RunnerHandle.exec. Secrets reach it by variable name only, never on its command line, and the
// page map it prints is outside data: the host decodes it with the engine's decodePageMap.
import { arch, platform } from 'node:os';
import {
  baseUrlOfOrigin, crawlSite, decodePageMap, exploreStartOrigin, failure, HOST_ISOLATION, redactPageMap, createRunService, sha256, unwiredPorts, success, UnavailableReason,
  type ArtifactStore, type BrowserDriver, type ClearedRun, type Clock, type ClosedSession, type EventSink, type ExploreDriver, type ExploreOptions,
  type ImageDigest, type Origin, type PageMap, type Project, type Redactor, type Result, type RunEventSink,
  type Runner, type SecretName, type SecretStore, type Session, type Target,
} from '@revisum/engine';
import { buildEgressPolicy } from '@revisum/runner';

// Why a crawl stopped, as the command reports it.
// target-unavailable: the browser did not open.
// plan-rejected: the --after plan did not pass, so the pages would not be the signed-in ones.
export type CrawlStop =
  | 'explore-origin-refused' | 'explore-start-unreachable' | 'explore-runner-unavailable' | 'target-unavailable' | 'plan-rejected';

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
} & ({ readonly login: ClearedRun } | { readonly project: Project; readonly target: Target });

// The page's random numbers are seeded, so a page that uses them shows the same each time.
const CRAWL_SEED = 0;

// The target a crawl opens its session on: the project's first Chromium target, since the crawl
// reads pages through the CDP driver.
export const crawlTarget = (project: Project): Target | undefined => project.matrix.find((target) => target.engine === 'chromium');

const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => { setTimeout(resolve, milliseconds); }),
};
// The --after run keeps nothing: no screenshot, step log or result file is written.
const discardingArtifacts: ArtifactStore = {
  put: async (name, bytes, mediaType) => ({ name, mediaType, sha256: sha256(bytes), bytes: bytes.length }),
};
const discardingRunEvents: RunEventSink = { append: () => undefined, read: () => [] };

// What the run is told when its close leaves the crawl's session open: what the session has noted by
// then. Only the run's state is read, and the crawl goes on using the session after it.
const keptOpen = (session: Session): Promise<ClosedSession> => Promise.resolve({ ...session.recordsSoFar(), closeFailure: null });

// A driver that hands the run the crawl's own session instead of opening another, and keeps it
// open when the run ends, so the crawl reads the pages the run signed in to. The session was opened
// for one target, so a run asking for any other is given none.
function sharingDriver(browser: BrowserDriver, session: Session, sessionTarget: Target): BrowserDriver {
  const shared = new Proxy(session, {
    get: (target, property): unknown => (property === 'close' ? () => keptOpen(session) : Reflect.get(target, property)),
  });
  return {
    info: browser.info,
    supports: (target) => browser.supports(target),
    open: async (target) => (target.id === sessionTarget.id
      ? success(shared)
      : failure({ reason: UnavailableReason.LaunchFailed, detail: `the crawl's session is for the target ${sessionTarget.id}, not ${target.id}` })),
  };
}

// The project and target the crawl's session is for: the --after run's own when there is one.
const sessionFor = (crawl: BrowserCrawl): { readonly project: Project; readonly target: Target } =>
  ('login' in crawl ? crawl.login : crawl);

export async function crawlInBrowser(browser: BrowserDriver, crawl: BrowserCrawl): Promise<Result<PageMap, CrawlStop>> {
  const { project, target } = sessionFor(crawl);
  const { options } = crawl;
  const origin = exploreStartOrigin(project, options.start);
  if (origin === undefined) return failure('explore-origin-refused');
  if (!browser.supports(target).ok) return failure('target-unavailable');
  const fixedTimeMilliseconds = Date.now();
  // The session may reach the start origin and nothing else.
  const baseUrl = baseUrlOfOrigin(origin);
  const opened = await browser.open(target, {
    baseUrl, allowedOrigins: [origin], seed: CRAWL_SEED, fixedTimeMilliseconds,
    sensitiveSelectors: crawl.redactor.selectors, timeoutMilliseconds: project.limits.stepTimeoutMilliseconds,
  });
  if (!opened.ok) return failure('target-unavailable');
  const session = opened.value;
  try {
    if ('login' in crawl) {
      const runService = createRunService({
        ...unwiredPorts,
        drivers: new Map([[target.adapter, sharingDriver(browser, session, target)]]), clock: systemClock, artifacts: discardingArtifacts,
        redactor: crawl.redactor, events: discardingRunEvents, audit: crawl.audit, secrets: crawl.secrets, isolation: HOST_ISOLATION,
      });
      const loggedIn = await runService.run(crawl.login, {
        baseUrl, seed: CRAWL_SEED, fixedTimeMilliseconds, fixtures: [], host: { platform: platform(), arch: arch() },
      });
      if (loggedIn.state !== 'Passed') return failure('plan-rejected');
    }
    // Navigation and reads only: nothing else of the session is in reach of the crawl.
    const explorer: ExploreDriver = {
      navigate: (url, navigation) => session.navigate(url, navigation),
      page: () => session.page(),
      accessibilitySnapshot: () => session.accessibilitySnapshot(),
      linkTargets: () => session.linkTargets(),
    };
    const crawled = await crawlSite(explorer, project, options, crawl.redactor);
    return crawled.ok ? crawled : failure(crawled.error.code);
  } finally {
    await session.close();
  }
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const fields: Readonly<Record<string, unknown>> = { ...value };
  const { start, maximumPages, maximumDepth, pageTimeoutMilliseconds, afterPlan, browserPath } = fields;
  if (typeof start !== 'string' || typeof maximumPages !== 'number' || typeof maximumDepth !== 'number' || typeof pageTimeoutMilliseconds !== 'number') return undefined;
  if ((afterPlan !== undefined && typeof afterPlan !== 'string') || (browserPath !== undefined && typeof browserPath !== 'string')) return undefined;
  return {
    project: fields['project'], start, maximumPages, maximumDepth, pageTimeoutMilliseconds,
    ...(afterPlan === undefined ? {} : { afterPlan }), ...(browserPath === undefined ? {} : { browserPath }),
  };
}

// Starts a run container whose egress reaches the start origin alone, crawls inside it, and
// decodes the page map it prints. A runner that cannot start or cannot enforce egress gives
// explore-runner-unavailable, with nothing crawled. The container is removed either way.
export async function crawlInRunner(
  isolated: IsolatedRunner, input: ContainerCrawlInput, origin: Origin, secretNames: readonly SecretName[], redactor: Redactor,
): Promise<Result<PageMap, CrawlStop>> {
  const policy = buildEgressPolicy({ allowOrigins: [origin], allowServices: [] });
  if (!policy.ok) return failure('explore-runner-unavailable');
  const started = await isolated.runner.start(isolated.image, policy.value);
  if (!started.ok) return failure('explore-runner-unavailable');
  const handle = started.value;
  try {
    if (handle.guaranteeLevel() !== 'isolated') return failure('explore-runner-unavailable');
    const given: ContainerCrawlInput = isolated.browserPath === undefined ? input : { ...input, browserPath: isolated.browserPath };
    const outcome = await handle.exec(['node', CONTAINER_CRAWL_MODULE, JSON.stringify(given)], secretNames);
    if (outcome.exitCode === CONTAINER_EXIT.startUnreachable) return failure('explore-start-unreachable');
    if (outcome.exitCode === CONTAINER_EXIT.loginRefused) return failure('plan-rejected');
    if (outcome.exitCode !== CONTAINER_EXIT.mapped) return failure('explore-runner-unavailable');
    let printed: unknown;
    try {
      printed = JSON.parse(outcome.stdout);
    } catch {
      return failure('explore-runner-unavailable');
    }
    const decoded = decodePageMap(printed, origin);
    if (!decoded.ok || decoded.value.guaranteeLevel !== 'isolated') return failure('explore-runner-unavailable');
    // The exec read the proxy's record back, so this says whether all of the crawl's egress was recorded.
    if (handle.guaranteeLevel() !== 'isolated') {
      return failure('explore-runner-unavailable');
    }
    // Redacted again on the host, in case the container lacked a secret's value.
    return success(redactPageMap(decoded.value, redactor));
  } finally {
    await handle.stop();
  }
}
