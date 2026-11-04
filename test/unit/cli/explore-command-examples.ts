// Shared setup for the tests of explore mode: `revisum draft --explore <url>`.
//
//   - startExploreSite() serves the Lantern Books fixture site (fixtures/explore-site/) on
//     loopback, and a second server on another port that the home page links to. Each records the
//     paths it is asked for. The home page sets a cookie, every page keeps a value in local storage,
//     and the contact page holds the seeded canaries: a filled text field, a paragraph, a
//     200-character button name, the declared secret's value and an email address;
//   - spyBrowser() is the real CDP driver, always headless, with every session it opens wrapped so
//     each call made on the session is recorded, with the session environment it was opened with;
//   - watchedFakeRunner() is an isolated runner that starts nothing: it records each start and exec, and
//     answers exec with a page map the test gives, as the crawl inside the container would print it;
//   - approvalOfPlan() mints a real approval for a plan, through the approval verifier, as the
//     maintainer's merge to the protected branch gives one;
//   - runExplore() runs the draft command with all of these, and gathers what it wrote.
//
// What these tests assume about shapes the spec leaves open, gathered here so a change to one is
// a change to this file only:
//   - DraftCommandPorts gains `browser` and `isolatedRunner`, as the build notes name them, and
//     `approvals`, an ApprovalStore holding the approvals the protected branch gives, against
//     which an --after plan's hash is checked. The build notes say the check is made "against the
//     trusted approvals from the protected branch, as a run checks them" without naming a port;
//   - the crawl opens its session on the project's one matrix target;
//   - RunnerHandle.exec takes the environment variable names after the command, as a list of text;
//   - the isolated crawl's exec prints the page map as JSON on standard output, exit code 0;
//   - --json's data holds the build notes' fields under the names they give.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowserDriver } from '#test-support/browser/CreateBrowserDriver.ts';
import {
  canonicalJson, environmentSecretStore, failure, planHash, planParser, readPlanText, sha256, success,
  type Approval, type ApprovalStore, type BrowserDriver, type EgressPolicy, type GuaranteeLevel, type ImageDigest, type Plan,
  type Runner, type Session, type SessionEnvironment,
} from '@revisum/engine';
import { BROWSERS } from '#test-support/browsers.ts';
import { startFixtureServer, type FixtureRoute } from '#test-support/fixture-server.ts';
import { fakeApprovalStore } from '#test-support/fakes/FakeApprovalStore.ts';
import { fakeDriver } from '#test-support/fakes/FakeDriver.ts';
import { fakeRunner } from '#test-support/fakes/FakeRunner.ts';
import { fakeRunnerHandle } from '#test-support/fakes/FakeRunnerHandle.ts';
import { memoryEventSink, type MemoryEventSink } from '#test-support/memory-ports.ts';
import { trustedProjectFrom } from '#test-support/policy-clearance.ts';
import { FIXTURES, GOLDEN } from '#test-support/repository.ts';
import { PLAN_PATH, openRepository } from '../engine/approval-repositories.ts';
import { letterNonce } from '../engine/secret-examples.ts';
import { consoleWrittenDuring, jsonAnswer, type Answer } from '../runner/local-service.ts';
import { PINNED_IMAGE_ID, fakeResolver, imageDigest, type FakeResolver } from '../runner/runner-examples.ts';
import {
  TEST_CERTIFICATE, draftWorkspace, loadDraftCommand, localPlanner, protectedBranchWith, startFakePlanner,
  type CommandOutcome, type DraftCommandPorts, type DraftWorkspace, type FakePlanner, type JsonRecord,
} from './draft-command-examples.ts';

// ---- The site --------------------------------------------------------------------------------------

const SITE_FOLDER = join(FIXTURES, 'explore-site');
const COMMAND_FOLDER = join(FIXTURES, 'explore-command');

export const TARGET_ID = 'explore-chromium';
export const PRODUCTION_ORIGIN = 'https://shop.example.com';
// Not declared: nothing listens there.
export const UNDECLARED_ORIGIN = 'http://127.0.0.1:9';
// The host the hostile page names, which nothing may ever look up or reach.
export const EVIL_HOST = 'evil.example.net';

// The seeded canaries, as the fixture site holds them. Letters only, so no personal-data pattern
// changes them, except the email address, which one must.
export const CANARIES = {
  paragraph: 'ParagraphcanaryWillowmereQuietlyHumsAlong',
  fieldValue: 'FieldvaluecanaryBrackenfoldMeadow',
  cookie: 'CookiecanaryThistledownMarsh',
  storage: 'StoragecanaryHollowbrookLane',
  email: 'grace.hopper@example.org',
} as const;
// Text of the home page outside any kept role, and a query and fragment of one of its links.
export const HOME_PARAGRAPH = 'A small shop of second hand books';
export const HOME_LINK_QUERY = 'plan=reader';
export const HOME_LINK_FRAGMENT = '#compare';
// Exactly 200 characters, on the contact page's button.
export const LONG_BUTTON_NAME = 'Send this message to the Lantern Books reading room team, who answer every letter by hand within two working '
  + 'days and keep a copy in the archive of reader letters kept since the old shop first opened.';

// The declared secret whose value the contact page shows, and the one the sign-in plan types.
export const OFFICE_KEY_NAME = 'EXPLORE_OFFICE_KEY';
export const OFFICE_KEY_VALUE = 'QuillfeatherMoonlitHarbourLantern';
export const LOGIN_NAME_SECRET = 'EXPLORE_LOGIN_NAME';

// The site's pages in crawl order with the default bounds (20 pages, depth 3), and the depth-4 page
// those bounds leave out.
export const DEFAULT_CRAWL: readonly (readonly [string, number])[] = [
  ['/', 0], ['/about.html', 1], ['/contact.html', 1], ['/notes.html', 1], ['/pricing.html', 1],
  ['/team.html', 2], ['/faq.html', 2], ['/careers.html', 3],
];
export const BEYOND_DEFAULT_DEPTH: readonly [string, number] = ['/archive.html', 4];

export type ExploreSite = {
  // The site under test, and the second declared origin its home page links to.
  readonly origin: string;
  readonly secondOrigin: string;
  // Paths each server was asked for, in order.
  readonly requested: readonly string[];
  readonly secondRequested: readonly string[];
  close(): Promise<void>;
};

// Where the site listens, and who else hears of each request. The ports are free ones unless
// given, as they are inside a run container (test/containers/explore-site-inside.ts).
export type ExploreSiteOptions = {
  readonly sitePort?: number;
  readonly secondPort?: number;
  readonly onRequest?: (server: 'site' | 'second', path: string) => void;
};

export async function startExploreSite(options: ExploreSiteOptions = {}): Promise<ExploreSite> {
  const secondRequested: string[] = [];
  const second = await startFixtureServer(SITE_FOLDER, (path) => {
    secondRequested.push(path);
    options.onRequest?.('second', path);
  }, new Map(), options.secondPort);
  const requested: string[] = [];
  const home = readFileSync(join(SITE_FOLDER, 'index.html'), 'utf8').replaceAll('{{SECOND_ORIGIN}}', second.origin);
  const homeRoute: FixtureRoute = () => ({
    headers: { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `shop-session=${CANARIES.cookie}; Path=/` },
    body: home,
  });
  const first = await startFixtureServer(SITE_FOLDER, (path) => {
    requested.push(path);
    options.onRequest?.('site', path);
  }, new Map([['/index.html', homeRoute]]), options.sitePort);
  return {
    origin: first.origin,
    secondOrigin: second.origin,
    requested,
    secondRequested,
    close: async () => { await first.close(); await second.close(); },
  };
}

// The trusted project for the site: its two origins and a production one, one CDP target, the two
// secrets and the planner.
export const exploreProjectFile = (site: ExploreSite, planner: JsonRecord): JsonRecord => ({
  origins: [site.origin, site.secondOrigin, PRODUCTION_ORIGIN],
  productionOrigins: [PRODUCTION_ORIGIN],
  matrix: [{
    id: TARGET_ID, adapter: 'cdp', engine: 'chromium', device: 'desktop-1280', locale: 'en-GB',
    timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
  }],
  secretNames: [OFFICE_KEY_NAME, LOGIN_NAME_SECRET],
  planner,
});

// ---- The recorded planner response, the sign-in plan and the notice -----------------------------

export const PLANNER_DRAFT = readFileSync(join(COMMAND_FOLDER, 'planner-draft.plan'), 'utf8');
const RECORDED_REPLY: unknown = JSON.parse(readFileSync(join(COMMAND_FOLDER, 'openai-chat-reply.json'), 'utf8'));
export const recordedExploreAnswer = (): Answer => jsonAnswer(200, RECORDED_REPLY);

export const SIGN_IN_PLAN = readFileSync(join(COMMAND_FOLDER, 'sign-in.plan'), 'utf8');
export const AFTER_PLAN_PATH = 'plans/explore-sign-in.plan';

// The fixed notice the command writes as the draft's first three lines.
export const NOTICE = '# Draft from explored pages: it checks what the pages do now, which may include bugs.\n'
  + '# Review each Expect line before you approve this plan.\n'
  + '#\n';
export const NOTICE_LINES = 3;

export const GOLDEN_EXPLORE_DRAFT = readFileSync(join(GOLDEN, 'drafts', 'explore-site.plan'), 'utf8');
export const GOLDEN_PAGE_MAP = readFileSync(join(GOLDEN, 'page-maps', 'explore-site.pages.json'), 'utf8');
export const GOLDEN_OUTPUT: unknown = JSON.parse(readFileSync(join(GOLDEN, 'explore-command', 'explore-site-output.json'), 'utf8'));
// The placeholders the golden files hold where a run's own origins and page map hash stand.
export const SITE_PLACEHOLDER = 'http://explore-site.test';
export const OUTPUT_SITE_PLACEHOLDER = '<fixture site origin>';
export const OUTPUT_PLANNER_PLACEHOLDER = '<planner origin>';
export const OUTPUT_REFERENCE_PLACEHOLDER = '<sha256 of the page map file>';

export const DRAFT_OUT = 'plans/explore.plan';
export const PAGE_MAP_OUT = 'plans/explore.pages.json';

// The explore command's arguments: --explore the start URL, --out the draft, then `extra`.
export const exploreArguments = (start: string, extra: readonly string[] = ['--host', '--json']): readonly string[] =>
  ['--explore', start, '--out', DRAFT_OUT, ...extra];

// ---- The browser, watched ------------------------------------------------------------------------

// One call made on a session: its method (a port's method as "network.stub"), and for navigate the URL.
export type SessionCall = { readonly method: string; readonly url?: string };

export type SpyBrowser = {
  readonly driver: BrowserDriver;
  // The environment of every session opened, in order.
  readonly opened: readonly SessionEnvironment[];
  readonly calls: readonly SessionCall[];
  navigations(): readonly string[];
};

// The calls a crawl may make on its session, besides ending it.
export const CRAWL_CALLS: readonly string[] = ['navigate', 'page', 'accessibilitySnapshot', 'linkTargets'];
export const UPKEEP_CALLS: readonly string[] = ['close', 'blockedOrigins', 'crashed'];
// Calls that act on the page or run script in it.
export const ACTING_CALLS: readonly string[] = ['act', 'download', 'runScript', 'frame', 'newTab', 'probe', 'screenshot', 'audit'];

const PORTS = ['network', 'storage', 'clock', 'clipboard'];

function recordingPort(name: string, port: object, calls: SessionCall[]): object {
  return new Proxy(port, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof property !== 'string' || typeof value !== 'function') return value;
      return (...inputs: readonly unknown[]) => {
        calls.push({ method: `${name}.${property}` });
        return Reflect.apply(value, target, inputs);
      };
    },
  });
}

function recordingSession(session: Session, calls: SessionCall[]): Session {
  return new Proxy(session, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (typeof property !== 'string') return value;
      if (PORTS.includes(property) && typeof value === 'object' && value !== null) return recordingPort(property, value, calls);
      if (typeof value !== 'function') return value;
      return (...inputs: readonly unknown[]) => {
        const first = inputs[0];
        calls.push(property === 'navigate' && typeof first === 'string' ? { method: property, url: first } : { method: property });
        return Reflect.apply(value, target, inputs);
      };
    },
  });
}

export function spyBrowser(): SpyBrowser {
  const inner = createBrowserDriver({ executablePath: BROWSERS.chrome });
  const opened: SessionEnvironment[] = [];
  const calls: SessionCall[] = [];
  const build = inner.build;
  return {
    driver: fakeDriver({
      info: inner.info,
      supports: (target) => inner.supports(target),
      async open(target, environment) {
        opened.push(environment);
        const session = await inner.open(target, environment);
        return session.ok ? success(recordingSession(session.value, calls)) : session;
      },
      ...(build === undefined ? {} : { build: (target) => Reflect.apply(build, inner, [target]) }),
    }, build === undefined ? ['build'] : []),
    opened,
    calls,
    navigations: () => calls.flatMap((call) => (call.method === 'navigate' && call.url !== undefined ? [call.url] : [])),
  };
}

// ---- The isolated runner, faked ----------------------------------------------------------------------

export type ExecCall = { readonly command: readonly string[]; readonly environmentNames: unknown };
export type WatchedFakeRunner = {
  readonly runner: Runner;
  readonly image: ImageDigest;
  readonly started: readonly EgressPolicy[];
  readonly execs: readonly ExecCall[];
  stops(): number;
};
export type WatchedFakeRunnerOptions = {
  readonly level: GuaranteeLevel;
  readonly startFails?: true;
  // What the crawl inside prints: the page map's JSON.
  readonly output?: string;
};

export function watchedFakeRunner(options: WatchedFakeRunnerOptions): WatchedFakeRunner {
  const started: EgressPolicy[] = [];
  const execs: ExecCall[] = [];
  let stops = 0;
  const handle = fakeRunnerHandle({
    runId: 'run-explore-fake',
    guaranteeLevel: () => options.level,
    async exec(command, environmentNames) {
      execs.push({ command, environmentNames });
      return { exitCode: 0, stdout: options.output ?? '', stderr: '' };
    },
    async stop() { stops += 1; },
  });
  const runner = fakeRunner({
    async start(image, policy) {
      started.push(policy);
      return options.startFails === true ? failure({ code: 'start-failed' }) : success(handle);
    },
    guaranteeLevel: () => options.level,
  });
  return { runner, image: imageDigest(PINNED_IMAGE_ID), started, execs, stops: () => stops };
}

// A page map as the crawl in the container prints it: pretty-printed, keys in no particular order.
export const containerPageMap = (origin: string): { readonly printed: string; readonly canonical: string } => {
  const map = {
    truncated: false,
    pages: [{ tree: [{ role: 'heading', children: [], name: 'Crawled inside the container' }], title: 'Lantern Books', path: '/', depth: 0 }],
    origin,
    guaranteeLevel: 'isolated',
  };
  return { printed: `${JSON.stringify(map, null, 2)}\n`, canonical: `${canonicalJson(map)}\n` };
};

// ---- Approvals ---------------------------------------------------------------------------------------

// The plan a readable text parses to under the trusted project.
export async function parsedPlan(text: string, project: JsonRecord): Promise<Plan> {
  const trusted = await trustedProjectFrom(project);
  const read = readPlanText(text, trusted.limits);
  if (!read.ok) assert.fail(`the plan text was refused: ${JSON.stringify(read.error)}`);
  const parsed = planParser(trusted)(read.value.json);
  if (!parsed.ok) assert.fail(`the plan was refused: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// A real, declared approval of the plan's hash: the maintainer merged it to the protected branch.
export async function approvalOfPlan(text: string, project: JsonRecord): Promise<Approval> {
  const plan = await parsedPlan(text, project);
  const repository = openRepository('solo', (fixture) => { fixture.protectedFiles[PLAN_PATH] = plan; });
  try {
    const verified = await repository.verify({ kind: 'plan', hash: planHash(plan), path: PLAN_PATH }, repository.lockdownProof());
    if (!verified.ok) assert.fail(`the plan was not approved: ${verified.error}`);
    return verified.value.approval;
  } finally {
    repository.dispose();
  }
}

// ---- Running the command -----------------------------------------------------------------------------

export type ExploreCommandPorts = DraftCommandPorts & {
  readonly browser?: BrowserDriver;
  readonly isolatedRunner?: { readonly runner: Runner; readonly image: ImageDigest };
  readonly approvals?: ApprovalStore;
};

export type ExploreSetup = {
  readonly argv: (site: ExploreSite) => readonly string[];
  // The planner's answer; the recorded explore reply unless given.
  readonly answer?: Answer;
  // The browser the command may use; a fresh spy unless given. `false` gives the command none.
  readonly browser?: SpyBrowser | false;
  readonly runner?: (site: ExploreSite) => WatchedFakeRunner;
  // A real isolated runner instead of the fake one, and the site it reaches, which then runs
  // elsewhere (inside the run container) rather than on this machine's loopback.
  readonly isolatedRunner?: (site: ExploreSite) => { readonly runner: Runner; readonly image: ImageDigest };
  readonly site?: () => Promise<ExploreSite>;
  readonly approvals?: readonly Approval[] | ((project: JsonRecord) => Promise<readonly Approval[]>);
  // Files to write into the workspace before the run, by relative path.
  readonly files?: Readonly<Record<string, string>>;
  // The secret store's variables; the two declared secrets, the login name fresh, unless given.
  readonly secrets?: Readonly<Record<string, string>>;
  readonly spec?: string;
};

export type ExploreRun = {
  readonly site: ExploreSite;
  readonly planner: FakePlanner;
  readonly workspace: DraftWorkspace;
  readonly browser: SpyBrowser | undefined;
  readonly runner: WatchedFakeRunner | undefined;
  readonly outcome: CommandOutcome;
  readonly printed: string;
  readonly events: MemoryEventSink;
  readonly resolver: FakeResolver;
  readonly output: JsonRecord | undefined;
  readonly loginName: string;
  readonly project: JsonRecord;
  // Runs the same command again, with the same ports, once the draft and page map are removed.
  again(): Promise<{ readonly outcome: CommandOutcome; readonly output: JsonRecord | undefined }>;
};

const parsedOutput = (stdout: string): JsonRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : undefined;
  } catch {
    return undefined;
  }
};

export const exploreSecrets = (loginName: string): Readonly<Record<string, string>> =>
  ({ [OFFICE_KEY_NAME]: OFFICE_KEY_VALUE, [LOGIN_NAME_SECRET]: loginName });

// Starts the site and a local fake planner, runs the command in a fresh workspace, hands the run
// to `body`, then closes everything.
export async function withExploreRun(setup: ExploreSetup, body: (run: ExploreRun) => Promise<void> | void): Promise<void> {
  const site = await (setup.site ?? startExploreSite)();
  const planner = await startFakePlanner(setup.answer ?? recordedExploreAnswer());
  const project = exploreProjectFile(site, localPlanner(planner.origin));
  const workspace = draftWorkspace({ planner: undefined, project, ...(setup.spec === undefined ? {} : { spec: setup.spec }) });
  try {
    for (const [path, content] of Object.entries(setup.files ?? {})) workspace.write(path, content);
    const loginName = `Readername${letterNonce(20)}`;
    const browser = setup.browser === false ? undefined : setup.browser ?? spyBrowser();
    const runner = setup.runner?.(site);
    const approvals = typeof setup.approvals === 'function' ? await setup.approvals(project) : setup.approvals;
    const events = memoryEventSink();
    // Every name the planner proxy looks up is recorded; the planner is on loopback, so none is needed.
    const resolver = fakeResolver({});
    const ports: ExploreCommandPorts = {
      workingDirectory: workspace.root,
      secrets: environmentSecretStore(setup.secrets ?? exploreSecrets(loginName)),
      events,
      versionControl: protectedBranchWith(workspace.protectedProject),
      trustedCertificates: [TEST_CERTIFICATE],
      resolve: resolver.resolve,
      ...(browser === undefined ? {} : { browser: browser.driver }),
      ...(runner === undefined ? {} : { isolatedRunner: { runner: runner.runner, image: runner.image } }),
      ...(setup.isolatedRunner === undefined ? {} : { isolatedRunner: setup.isolatedRunner(site) }),
      ...(approvals === undefined ? {} : { approvals: fakeApprovalStore(approvals) }),
    };
    const command = await loadDraftCommand();
    let outcome: CommandOutcome | undefined;
    const printed = await consoleWrittenDuring(async () => { outcome = await command(setup.argv(site), ports); });
    assert.ok(outcome !== undefined, 'the draft command gave no outcome');
    const again = async () => {
      workspace.remove(DRAFT_OUT);
      workspace.remove(PAGE_MAP_OUT);
      const repeated = await command(setup.argv(site), ports);
      return { outcome: repeated, output: parsedOutput(repeated.stdout) };
    };
    await body({
      site, planner, workspace, browser, runner, outcome, printed, events, resolver, output: parsedOutput(outcome.stdout), loginName, project, again,
    });
  } finally {
    await planner.close();
    await site.close();
    workspace.dispose();
  }
}

// ---- Reading what the command did -----------------------------------------------------------------

export function exploreData(run: ExploreRun): JsonRecord {
  assert.ok(run.output !== undefined, `stdout is not one JSON object:\n${run.outcome.stdout}\n${run.outcome.stderr}`);
  const data = run.output['data'];
  assert.ok(typeof data === 'object' && data !== null && !Array.isArray(data), `the output has no data object: ${run.outcome.stdout}`);
  return { ...data };
}

export function exploreErrorCodes(run: ExploreRun): readonly string[] {
  assert.ok(run.output !== undefined, `stdout is not one JSON object:\n${run.outcome.stdout}\n${run.outcome.stderr}`);
  const errors = run.output['errors'];
  if (!Array.isArray(errors)) return [];
  return errors.map((error: unknown) => (typeof error === 'object' && error !== null ? String(Reflect.get(error, 'code')) : ''));
}

// The page map file the command wrote, as text.
export function pageMapText(run: ExploreRun): string {
  assert.ok(run.workspace.exists(PAGE_MAP_OUT), `no page map was written:\n${run.outcome.stdout}\n${run.outcome.stderr}`);
  return run.workspace.read(PAGE_MAP_OUT);
}

export type WrittenNode = { readonly role: string; readonly name: string; readonly children: readonly WrittenNode[] };
export type WrittenPage = { readonly path: string; readonly title: string; readonly depth: number; readonly tree: readonly WrittenNode[] };
export type WrittenMap = { readonly origin: string; readonly truncated: boolean; readonly guaranteeLevel: string; readonly pages: readonly WrittenPage[] };

const nodesOf = (value: unknown): readonly WrittenNode[] => {
  assert.ok(Array.isArray(value), 'a tree is not a list');
  return value.map((node: unknown): WrittenNode => {
    assert.ok(typeof node === 'object' && node !== null);
    const role: unknown = Reflect.get(node, 'role');
    const name: unknown = Reflect.get(node, 'name');
    assert.ok(typeof role === 'string' && typeof name === 'string', 'a node has no role or name');
    return { role, name, children: nodesOf(Reflect.get(node, 'children')) };
  });
};

// The page map file, decoded.
export function writtenMap(run: ExploreRun): WrittenMap {
  const parsed: unknown = JSON.parse(pageMapText(run));
  assert.ok(typeof parsed === 'object' && parsed !== null);
  const origin: unknown = Reflect.get(parsed, 'origin');
  const truncated: unknown = Reflect.get(parsed, 'truncated');
  const guaranteeLevel: unknown = Reflect.get(parsed, 'guaranteeLevel');
  const pages: unknown = Reflect.get(parsed, 'pages');
  assert.ok(typeof origin === 'string' && typeof truncated === 'boolean' && typeof guaranteeLevel === 'string' && Array.isArray(pages));
  return {
    origin, truncated, guaranteeLevel,
    pages: pages.map((page: unknown): WrittenPage => {
      assert.ok(typeof page === 'object' && page !== null);
      const path: unknown = Reflect.get(page, 'path');
      const title: unknown = Reflect.get(page, 'title');
      const depth: unknown = Reflect.get(page, 'depth');
      assert.ok(typeof path === 'string' && typeof title === 'string' && typeof depth === 'number');
      return { path, title, depth, tree: nodesOf(Reflect.get(page, 'tree')) };
    }),
  };
}

export const allWrittenNodes = (tree: readonly WrittenNode[]): readonly WrittenNode[] => tree.flatMap((node) => [node, ...allWrittenNodes(node.children)]);
export const crawlOrder = (map: WrittenMap): readonly (readonly [string, number])[] => map.pages.map((page) => [page.path, page.depth] as const);

// The page map's provenance reference: sha256: and the hex sha256 of the file's bytes.
export const pageMapReference = (run: ExploreRun): string => `sha256:${sha256(new TextEncoder().encode(pageMapText(run)))}`;

// Everything the run left behind, for leak scans: its outcome, the console, the audit events,
// every file it wrote or changed, and every request the planner received.
export function everythingExplored(run: ExploreRun, before: ReadonlyMap<string, string> = new Map()): string {
  const changedFiles = [...run.workspace.snapshot()].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => run.workspace.read(path));
  return [
    run.outcome.stdout, run.outcome.stderr, run.printed, JSON.stringify(run.events.recorded), ...changedFiles,
    ...run.planner.received.map((request) => request.body),
  ].join('\n');
}

// The one request the planner received, as text and with its JSON escapes undone.
export function plannerRequestTexts(run: ExploreRun): readonly string[] {
  assert.equal(run.planner.received.length, 1, `the planner received ${run.planner.received.length} requests`);
  const request = run.planner.received[0];
  assert.ok(request !== undefined);
  const body: unknown = JSON.parse(request.body);
  const unescaped: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') unescaped.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(collect);
  };
  collect(body);
  return [request.body, unescaped.join('\n')];
}

// The draft file the command wrote, if any.
export const draftText = (run: ExploreRun): string | undefined => (run.workspace.exists(DRAFT_OUT) ? run.workspace.read(DRAFT_OUT) : undefined);

// The draft with one line of the recorded planner text replaced, and that line's number in the
// written file, the notice counted.
export function exploreDraftWithLine(find: string, replacement: string): { readonly text: string; readonly line: number } {
  const lines = PLANNER_DRAFT.split('\n');
  const index = lines.indexOf(find);
  assert.ok(index !== -1, `the recorded draft has no line ${find}`);
  lines[index] = replacement;
  return { text: lines.join('\n'), line: NOTICE_LINES + index + 1 };
}
