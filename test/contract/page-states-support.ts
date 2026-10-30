// Shared setup for the browser tests of plan language 1.2's page checks, downloads and second
// tab: accessibility states, link targets, head metadata, pages loaded with scripts off, the
// download step and its checks, and newTab blocks.
//
// It serves the page-states fixture app (fixtures/page-states-app/) and, beside its files, routes
// the tests build: files to download under /exports/ (a CSV, an empty CSV, a CSV larger than the
// project's download limit streamed with no Content-Length, a PNG, and files whose server-sent
// names are hostile), /sign-in, which sets an HttpOnly session cookie, and /account, which shows
// whether the browser sent that cookie. Every file to download holds a marker made fresh for the
// harness, so a test can search the disk for any copy of it.
//
// Plans are written as raw JSON, parsed against a trusted project, cleared through the policy
// gate and run with run(). The project's targets are the own CDP driver on Chrome for Testing and
// the Playwright fallback on Chromium, in English and London time, with a 64 KiB download limit.
// Every run reads the page just before the run closes its session, after an optional test hook.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { arch, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cdpDriver } from '@revisum/driver-cdp';
import { playwrightDriver } from '@revisum/driver-playwright';
import {
  defaultRedactor, parseProject, planParser, run,
  type ActionStep, type BrowserDriver, type Locator, type Plan, type Project, type RunEventSink, type RunResult, type Session,
  type SessionEnvironment, type Target, type TargetId,
} from '@revisum/engine';
import { BROWSERS } from '../support/browsers.ts';
import { startFixtureServer, type FixtureResponse, type FixtureRoute, type FixtureServer } from '../support/fixture-server.ts';
import {
  memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock, type MemoryArtifactStore, type MemoryEventSink,
} from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { FIXTURES } from '../support/repository.ts';
import type { JsonRecord } from './plan-values-support.ts';

export {
  click, fill, label, navigate, outcomes, reference, reusedSessionDriver, role, testId, textEquals, type JsonRecord,
} from './plan-values-support.ts';

export const SEED = 31;
// The run's own clock start: 30 October 2026, 12:00 UTC.
export const CLOCK_START_MILLISECONDS = Date.UTC(2026, 9, 30, 12, 0, 0);
export const PLAN_LANGUAGE_VERSION = '1.2';
export const STEP_TIMEOUT_MILLISECONDS = 2000;
export const MAXIMUM_DOWNLOAD_BYTES = 64 * 1024;

export const CDP_TARGET = 'cdp-chromium';
export const PLAYWRIGHT_TARGET = 'playwright-chromium';

const FIXTURE_FOLDER = join(FIXTURES, 'page-states-app');

const desktop = {
  device: 'desktop-1280', locale: 'en-GB', timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
} as const;

// The project file as a person writes it. `keepDownloads` adds an evidence section.
export const pageStatesProjectFile = (origin: string, keepDownloads?: boolean) => ({
  origins: [origin],
  limits: { stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS, maximumDownloadBytes: MAXIMUM_DOWNLOAD_BYTES },
  ...(keepDownloads === undefined ? {} : { evidence: { keepDownloads } }),
  matrix: [
    { id: CDP_TARGET, adapter: 'cdp', engine: 'chromium', ...desktop },
    { id: PLAYWRIGHT_TARGET, adapter: 'playwright', engine: 'chromium', ...desktop },
  ],
});

export const pageStatesDrivers = (): ReadonlyMap<string, BrowserDriver> => new Map<string, BrowserDriver>([
  ['cdp', cdpDriver({ executablePath: BROWSERS.chrome })],
  ['playwright', playwrightDriver()],
]);

// ---- Plans, written as raw JSON -------------------------------------------------------------

export const navigateWithoutScripts = (url: unknown): JsonRecord => ({ type: 'navigate', url, scripts: 'disabled' });
export const expectState = (locator: JsonRecord, kind: string, criterionId: string): JsonRecord =>
  ({ type: 'expect', locator, assert: { kind }, criterionId });
export const hrefEquals = (locator: JsonRecord, value: unknown, criterionId: string): JsonRecord =>
  ({ type: 'expect', locator, assert: { kind: 'hrefEquals', value }, criterionId });
export const metaContent = (name: string, value: unknown, criterionId: string): JsonRecord =>
  ({ type: 'expectPage', assert: { kind: 'metaContent', name, value }, criterionId });
export const canonicalUrl = (value: string, criterionId: string): JsonRecord =>
  ({ type: 'expectPage', assert: { kind: 'canonicalUrl', value }, criterionId });
export const download = (name: string, locator: JsonRecord): JsonRecord => ({ type: 'download', name, locator });
export const expectDownload = (name: string, assertion: JsonRecord, criterionId: string): JsonRecord =>
  ({ type: 'expectDownload', download: name, assert: assertion, criterionId });
export const newTab = (url: string, steps: readonly unknown[]): JsonRecord => ({ type: 'newTab', url, steps });

// A raw 1.2 plan for one target. `fields` adds top-level fields. A plan must assert something;
// every test plan here does.
export const pagePlan = (targetId: string, steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => ({
  version: PLAN_LANGUAGE_VERSION,
  meta: { featureId: 'STATES-1', specReference: 'specs/page-states.md#driver', title: 'Page states, downloads and tabs in a browser' },
  targets: [targetId],
  steps,
  ...fields,
});

// ---- Files to download ------------------------------------------------------------------------

// A file a route serves as a download: where it is, the name and media type the server sends,
// its bytes and the marker text they hold.
export type ServedFile = {
  readonly path: string;
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Buffer;
  readonly marker: string;
};

// A file whose server-sent name is hostile, and the link on downloads.html that fetches it.
export type HostileFile = ServedFile & { readonly linkName: string; readonly kind: string };

export type ExportFiles = {
  readonly projects: ServedFile;
  readonly empty: ServedFile;
  readonly invoices: ServedFile;
  readonly logo: ServedFile;
  readonly contacts: ServedFile;
  // Larger than MAXIMUM_DOWNLOAD_BYTES; every line of it holds the marker.
  readonly oversize: ServedFile;
};

const attachment = (fileName: string): string => `attachment; filename="${fileName}"`;
// A name sent in RFC 6266's extended form, so it reaches the browser exactly as written.
const extendedAttachment = (fileName: string): string => `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;

const served = (path: string, fileName: string, mediaType: string, text: string, marker: string): ServedFile =>
  ({ path, fileName, mediaType, bytes: Buffer.from(text, 'utf8'), marker });

function exportFiles(nonce: string, contactsText: string | undefined): ExportFiles {
  const projectsMarker = `projects-export-${nonce}`;
  const invoicesMarker = `invoices-export-${nonce}`;
  const logoMarker = `logo-export-${nonce}`;
  const contactsMarker = `contacts-export-${nonce}`;
  const oversizeMarker = `oversize-history-${nonce}`;
  const oversizeLine = `${oversizeMarker},Archived row,0000\n`;
  const oversizeText = oversizeLine.repeat(Math.ceil((4 * MAXIMUM_DOWNLOAD_BYTES) / oversizeLine.length));
  // A real PNG signature and header chunk, then the marker inside a text chunk: bytes that are not
  // UTF-8 text (0x89, 0xFF and zero bytes), though "PNG" and the marker are readable in them.
  const logoBytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 0x1f, 0x15, 0xc4, 0x89]),
    Buffer.from(`tEXt${logoMarker}`, 'latin1'),
    Buffer.from([0xff, 0xfe, 0x00, 0x00, 0xff]),
  ]);
  return {
    projects: served('/exports/projects.csv', 'projects.csv', 'text/csv',
      `Project,Owner,Status\nWebsite relaunch,Priya,Active\nMobile app,Tomas,Planned\nReference,${projectsMarker},\n`, projectsMarker),
    empty: served('/exports/empty.csv', 'empty.csv', 'text/csv', '', ''),
    invoices: served('/exports/invoices.csv', 'invoices.csv', 'text/csv', `Invoice,Total\nINV-1,120\nReference,${invoicesMarker}\n`, invoicesMarker),
    logo: { path: '/exports/logo.png', fileName: 'logo.png', mediaType: 'image/png', bytes: logoBytes, marker: logoMarker },
    contacts: served('/exports/contacts.csv', 'contacts.csv', 'text/csv',
      contactsText ?? `Contact,Team\nReception,Front desk\nReference,${contactsMarker}\n`, contactsMarker),
    oversize: served('/exports/oversize.csv', 'oversize.csv', 'text/csv', oversizeText, oversizeMarker),
  };
}

function hostileFiles(nonce: string): readonly HostileFile[] {
  const hostile = (kind: string, linkName: string, fileName: string): HostileFile => {
    const marker = `hostile-download-${nonce}-${kind}`;
    return { kind, linkName, fileName, path: `/exports/hostile/${kind}`, mediaType: 'text/plain', bytes: Buffer.from(`${marker}\nA file with a hostile name.\n`, 'utf8'), marker };
  };
  return [
    hostile('parent-path', 'Export parent path', '../../etc/passwd'),
    // The same shape with a name only this harness uses, so a search of the disk can find it.
    hostile('parent-escape', 'Export escaping name', `../../revisum-escaped-${nonce}.txt`),
    hostile('absolute-path', 'Export absolute path', join(tmpdir(), `revisum-escaped-${nonce}-absolute.txt`)),
    hostile('device-con', 'Export device name', 'CON'),
    hostile('device-nul', 'Export null device name', 'NUL.txt'),
  ];
}

// The session cookie /sign-in sets, and what /account shows for it.
export const SESSION_COOKIE = 'session=signed-in-ada';

function routesFor(files: ExportFiles, hostile: readonly HostileFile[]): ReadonlyMap<string, FixtureRoute> {
  const routes = new Map<string, FixtureRoute>();
  const downloadRoute = (file: ServedFile, disposition: string): FixtureRoute => (): FixtureResponse =>
    ({ headers: { 'content-type': file.mediaType, 'content-disposition': disposition }, body: file.bytes });
  for (const file of [files.projects, files.empty, files.invoices, files.logo, files.contacts]) {
    routes.set(file.path, downloadRoute(file, attachment(file.fileName)));
  }
  // Sent in 16 KiB pieces with no Content-Length, so the size is known only as the bytes arrive.
  const pieceSize = 16 * 1024;
  const pieces: Buffer[] = [];
  for (let start = 0; start < files.oversize.bytes.length; start += pieceSize) pieces.push(files.oversize.bytes.subarray(start, start + pieceSize));
  routes.set(files.oversize.path, () => ({
    headers: { 'content-type': files.oversize.mediaType, 'content-disposition': attachment(files.oversize.fileName) },
    chunks: pieces, chunkPauseMilliseconds: 20,
  }));
  for (const file of hostile) routes.set(file.path, downloadRoute(file, extendedAttachment(file.fileName)));

  routes.set('/sign-in', () => ({
    status: 302, headers: { location: '/signed-in.html', 'set-cookie': `${SESSION_COOKIE}; HttpOnly; Path=/; SameSite=Lax` },
  }));
  const accountTemplate = readFileSync(join(FIXTURE_FOLDER, 'account.html'), 'utf8');
  routes.set('/account', (request) => {
    const signedIn = request.cookie.split(';').map((part) => part.trim()).includes(SESSION_COOKIE);
    return { headers: { 'content-type': 'text/html; charset=utf-8' }, body: accountTemplate.replace('SESSION_STATE', signedIn ? 'Signed in' : 'Signed out') };
  });
  return routes;
}

// ---- Reading the page at close --------------------------------------------------------------

// What the page showed just before the run closed its session: its URL, and the text of each
// test id the run was asked to read (null when that test id matched no single element).
export type PageAtClose = { readonly url: string; readonly shown: Readonly<Record<string, string | null>> };

// Wraps a driver so the sessions it opens run `atClose` as their close() begins, before the
// inner session closes.
function hookedAtClose(inner: BrowserDriver, atClose: (session: Session) => Promise<void>): BrowserDriver {
  return new Proxy(inner, {
    get(target, key) {
      if (key !== 'open') return Reflect.get(target, key, target);
      return async (openTarget: Target, environment: SessionEnvironment) => {
        const opened = await target.open(openTarget, environment);
        if (!opened.ok) return opened;
        const session = opened.value;
        const close = async (): Promise<void> => {
          try { await atClose(session); } finally { await session.close(); }
        };
        const wrapped = new Proxy(session, {
          get(sessionTarget, sessionKey) {
            if (sessionKey === 'close') return close;
            const value: unknown = Reflect.get(sessionTarget, sessionKey, sessionTarget);
            return typeof value === 'function' ? value.bind(sessionTarget) : value;
          },
        });
        return { ok: true as const, value: wrapped };
      };
    },
  });
}

// ---- The harness ----------------------------------------------------------------------------

export type PageRun = {
  readonly result: RunResult;
  readonly events: RunEventSink;
  readonly audit: MemoryEventSink;
  readonly store: MemoryArtifactStore;
  // Null when no session opened, or it was never closed.
  readonly atClose: PageAtClose | null;
  // The paths the fixture server was asked for during the run, in order.
  readonly requestedPaths: readonly string[];
  // When the run began, in milliseconds since the epoch, for searching the disk afterwards.
  readonly startedAt: number;
};

export type PageRunOptions = {
  // Test ids whose text to read at close; the input-event counter by default.
  readonly read?: readonly string[];
  // Drivers by adapter id, in place of the harness's own.
  readonly drivers?: ReadonlyMap<string, BrowserDriver>;
  // Runs as the session's close() begins, before the page is read, while every file and tab the
  // session holds is still there.
  readonly beforeClose?: (session: Session, startedAt: number) => Promise<void>;
};

export type PageStatesHarnessOptions = {
  // Sets the project's evidence.keepDownloads; absent leaves the project without an evidence section.
  readonly keepDownloads?: boolean;
  // The text /exports/contacts.csv serves, in place of a harmless default.
  readonly contactsText?: string;
};

export type PageStatesHarness = {
  readonly server: FixtureServer;
  readonly origin: string;
  readonly project: Project;
  // The harness's own drivers by adapter id, made once.
  readonly drivers: ReadonlyMap<string, BrowserDriver>;
  // Fresh for this harness: part of every marker and escaping name it serves.
  readonly nonce: string;
  readonly files: ExportFiles;
  readonly hostileFiles: readonly HostileFile[];
  plan(raw: unknown): Plan;
  // One locator or action step, parsed by the real parser so a direct session call gets branded values.
  locator(raw: JsonRecord): Locator;
  actionStep(raw: JsonRecord): ActionStep;
  target(targetId: string): Target;
  run(plan: Plan, targetId: string, options?: PageRunOptions): Promise<PageRun>;
  // pagePlan, parsed and run on the target.
  runSteps(targetId: string, steps: readonly unknown[], options?: PageRunOptions & { readonly fields?: JsonRecord }): Promise<PageRun>;
  url(path: string): string;
  close(): Promise<void>;
};

export async function pageStatesHarness(options: PageStatesHarnessOptions = {}): Promise<PageStatesHarness> {
  const nonce = randomBytes(6).toString('hex');
  const files = exportFiles(nonce, options.contactsText);
  const hostile = hostileFiles(nonce);
  const requested: string[] = [];
  const server = await startFixtureServer(FIXTURE_FOLDER, (path) => { requested.push(path); }, routesFor(files, hostile));
  const projectFile = pageStatesProjectFile(server.origin, options.keepDownloads);
  const parsedProject = parseProject(projectFile);
  if (!parsedProject.ok) throw new Error(`bad page-states project: ${JSON.stringify(parsedProject.error)}`);
  const project = parsedProject.value;
  const trusted = await trustedProjectFrom(projectFile);
  const parse = planParser(project);
  const plan = (raw: unknown): Plan => {
    const parsed = parse(raw);
    if (!parsed.ok) throw new Error(`test plan rejected: ${JSON.stringify(parsed.error)}`);
    return parsed.value;
  };
  const PROBE_CHECK = { type: 'expect', locator: { by: 'testId', testId: 'input-events' }, assert: { kind: 'visible' }, criterionId: 'probe.page-shown' };
  const singleStep = (raw: JsonRecord) => {
    const step = plan(pagePlan(CDP_TARGET, [{ type: 'navigate', url: '/' }, raw, PROBE_CHECK])).steps[1];
    assert.ok(step !== undefined);
    return step;
  };
  const locator = (raw: JsonRecord): Locator => {
    const step = singleStep({ type: 'expect', locator: raw, assert: { kind: 'visible' }, criterionId: 'probe.located' });
    assert.ok(step.type === 'expect');
    return step.locator;
  };
  const actionStep = (raw: JsonRecord): ActionStep => {
    const step = singleStep(raw);
    assert.ok(step.type === 'click', `${step.type} is not a click`);
    return step;
  };
  const target = (targetId: string): Target => {
    const found = project.matrix.find((candidate) => candidate.id === targetId);
    assert.ok(found, `no target ${targetId}`);
    return found;
  };
  const drivers = pageStatesDrivers();

  const readPage = async (session: Session, testIds: readonly string[]): Promise<PageAtClose> => {
    const shown: Record<string, string | null> = {};
    for (const id of testIds) {
      const probed = await session.probe(locator({ by: 'testId', testId: id }));
      shown[id] = probed.count === 1 ? probed.text : null;
    }
    return { url: (await session.page()).url, shown };
  };

  const runPlan = async (parsedPlan: Plan, targetId: string, runOptions: PageRunOptions = {}): Promise<PageRun> => {
    const chosen = runOptions.drivers ?? drivers;
    const pages: PageAtClose[] = [];
    const startedAt = Date.now();
    const testIds = runOptions.read ?? ['input-events'];
    const atClose = async (session: Session): Promise<void> => {
      if (runOptions.beforeClose !== undefined) await runOptions.beforeClose(session, startedAt);
      pages.push(await readPage(session, testIds));
    };
    const hooked = new Map([...chosen].map(([adapter, driver]) => [adapter, hookedAtClose(driver, atClose)] as const));
    const events = memoryRunEventSink();
    const audit = memoryEventSink();
    const store = memoryArtifactStore();
    const firstRequest = requested.length;
    // The target id comes from the trusted test project, so it is used as the branded value directly.
    const result = await run({
      project, baseUrl: server.origin, seed: SEED, fixedTimeMilliseconds: CLOCK_START_MILLISECONDS,
      fixtures: server.fixtures, host: { platform: platform(), arch: arch() }, plan: authorise(parsedPlan, trusted), targetId: targetId as TargetId,
    }, {
      drivers: hooked, clock: systemClock, artifacts: store, redactor: defaultRedactor(), audit, events,
    });
    return { result, events, audit, store, atClose: pages[0] ?? null, requestedPaths: requested.slice(firstRequest), startedAt };
  };

  return {
    server, origin: server.origin, project, drivers, nonce, files, hostileFiles: hostile, plan, locator, actionStep, target,
    run: runPlan,
    runSteps: (targetId, steps, runOptions = {}) => runPlan(plan(pagePlan(targetId, steps, runOptions.fields ?? {})), targetId, runOptions),
    url: (path) => `${server.origin}${path}`,
    close: () => server.close(),
  };
}

// Waits until the probe of a test id shows text other than `pending`, for up to `limit`
// milliseconds, and gives the last text seen.
export async function settledText(harness: PageStatesHarness, session: Session, id: string, pending: string, limit = 3000): Promise<string> {
  const deadline = Date.now() + limit;
  let shown = pending;
  while (Date.now() < deadline) {
    const probed = await session.probe(harness.locator({ by: 'testId', testId: id }));
    shown = probed.count === 1 ? probed.text : '(not one element)';
    if (shown !== pending) return shown;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return shown;
}
