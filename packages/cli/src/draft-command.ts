// The draft command (route c), and its explore mode:
//   revisum draft --from <spec.md> [--criteria AC-1,AC-3] --out plans/<name>.plan [--json]
//   revisum draft --explore <url> [--from <spec.md>] [--after <approved.plan>] [--max-pages 20]
//                 [--max-depth 3] [--host] --out plans/<name>.plan [--json]
// It sends the planner only the spec's acceptance criteria (if any), the readable grammar's
// version, the project's declared origins and targets and, in explore mode, the crawl's page map,
// and writes the planner's text as an unapproved readable draft, with its errors by line. It never
// approves or runs the draft: what it hands on is a PlanDraft, which only the engine's admitDraft
// door turns into a Plan, and the lint keeps the engine's run function out of this module.
//
// The planner endpoint is read from the protected branch's project.json, never the working tree's,
// so a change under test cannot send the key elsewhere. The call goes through runner's service
// caller behind an in-process egress proxy that allows only the planner's origin; a local
// endpoint must be on loopback. Output that is not text, looks like script or is too long writes
// no draft and reports plan-rejected.
//
// Explore mode crawls the running app first, with no AI (explore-crawl.ts): from a start URL on a
// declared, non-production origin, in the isolated runner unless --host is given, after an
// approved --after plan if one is named. The page map is written beside the draft and its sha256 is
// the draft's provenance reference. The command writes a fixed notice above the model's text, and
// warns, by line, of locators that are not on their page or match more than one element.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  DEFAULT_EXPLORE_DEPTH, DEFAULT_EXPLORE_PAGES, DEFAULT_PAGE_TIMEOUT_MILLISECONDS, MAXIMUM_EXPLORE_DEPTH, MAXIMUM_EXPLORE_PAGES,
  READABLE_GRAMMAR_VERSION, admitCoreDraft, checkDraftLocators, defaultRedactor, exploreStartOrigin, extractCriteria, loadTrustedProject,
  pageMapReference, pageMapText, parseAiText, parseProject, planParser, planStanding, plannerOrigin, plannerReplyText, policyGate,
  readPlanText, withDeclaredSecretRedaction,
  type ApprovalStore, type BrowserDriver, type CliErrorCode, type CriterionText, type DraftError, type DraftRequest,
  type DraftWarning, type EventSink, type Origin, type PageMap, type PlanDraft, type PlannerEndpoint, type PlanProvenance, type PlanSource, type Project,
  type Redactor, type SecretStore, type Target, type TrustedProject, type VersionControlPort,
} from '@revisum/engine';
import { serviceCaller, startProxyServer, type AddressConnector, type AddressResolver } from '@revisum/runner';
import { CLI_OUTPUT_SCHEMA, cliError, exitCodeFor, type CliError, type CliOutput, type CommandOutcome } from './cli-output.ts';
import { crawlInBrowser, crawlInRunner, crawlTarget, type BrowserCrawl, type CrawlStop, type IsolatedRunner } from './explore-crawl.ts';
import { isLoopbackEndpoint, plannerAdapter } from './planner-adapters.ts';

export type DraftCommandPorts = {
  // The project folder: --from, --out and --after are relative to it.
  readonly workingDirectory: string;
  readonly secrets: SecretStore;
  // Where the command appends its audit events.
  readonly events: EventSink;
  // The protected branch, where the trusted project.json is read.
  readonly versionControl: VersionControlPort;
  // Handed to the egress proxy; it resolves and connects for real unless given.
  readonly resolve?: AddressResolver;
  readonly connect?: AddressConnector;
  // PEM certificates trusted for HTTPS besides the system's own, such as a test authority.
  readonly trustedCertificates?: readonly string[];
  // Explore mode's browser on the host, used only with --host. Always headless.
  readonly browser?: BrowserDriver;
  // The isolated runner and its pinned image, where explore mode crawls without --host.
  readonly isolatedRunner?: IsolatedRunner;
  // The approvals the protected branch gives, against which an --after plan's hash is checked.
  readonly approvals?: ApprovalStore;
};

// What the command reports for a written draft. The draft is never approved by the command.
// In explore mode it also gives where the page map was written and whether egress was enforced
// while the crawl ran.
export type DraftCommandResult = {
  readonly draftPath: string;
  readonly provenance: PlanProvenance;
  readonly errors: readonly DraftError[];
  readonly approved: false;
  readonly pageMapPath?: string;
  readonly warnings: readonly DraftWarning[];
  readonly egressEnforced?: boolean;
};
// With --json, the result, the origin explore mode crawled and the planner origins the command
// called, as the record of its egress.
export type DraftCommandData = DraftCommandResult & { readonly crawledOrigin?: string; readonly calledOrigins: readonly string[] };

const PROJECT_FILE = 'project.json';
const DRAFT_EXTENSION = '.plan';
const PAGE_MAP_EXTENSION = '.pages.json';
// Written by the command, never the model, as the first three lines of an explore draft.
const EXPLORE_NOTICE = '# Draft from explored pages: it checks what the pages do now, which may include bugs.\n'
  + '# Review each Expect line before you approve this plan.\n'
  + '#\n';
const NO_APPROVALS: ApprovalStore = { forSubject: () => [] };

type ExploreArguments = {
  readonly start: string;
  readonly after?: string;
  readonly maximumPages: number;
  readonly maximumDepth: number;
  readonly host: boolean;
};
type DraftArguments = {
  readonly from?: string;
  readonly out: string;
  readonly criteria?: readonly string[];
  readonly json: boolean;
  readonly explore?: ExploreArguments;
};

// A failure the command stops with: its code and, when it helps, where.
type Stop = { readonly stopped: CliError };
const stop = (code: CliErrorCode, path?: string): Stop => ({ stopped: cliError(code, path) });

const VALUE_FLAGS = ['--from', '--out', '--criteria', '--explore', '--after', '--max-pages', '--max-depth'];
const EXPLORE_ONLY_FLAGS = ['--after', '--max-pages', '--max-depth', '--host'];

// A whole number from `lowest` to `highest`, written in digits alone, or undefined.
function boundOf(text: string | undefined, fallback: number, lowest: number, highest: number): number | undefined {
  if (text === undefined) return fallback;
  if (!/^\d{1,3}$/.test(text)) return undefined;
  const value = Number(text);
  return value >= lowest && value <= highest ? value : undefined;
}

function readArguments(argv: readonly string[]): DraftArguments | Stop {
  const values = new Map<string, string>();
  let json = false;
  let host = false;
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index];
    if (word === '--json') { json = true; continue; }
    if (word === '--host') { host = true; continue; }
    if (word === undefined || !VALUE_FLAGS.includes(word)) return stop('usage', word);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || values.has(word)) return stop('usage', word);
    values.set(word, value);
    index += 1;
  }
  const from = values.get('--from');
  const out = values.get('--out');
  const start = values.get('--explore');
  if (start === undefined) {
    const exploreOnly = EXPLORE_ONLY_FLAGS.find((flag) => values.has(flag) || (flag === '--host' && host));
    if (exploreOnly !== undefined) return stop('usage', exploreOnly);
  }
  if (from === undefined && start === undefined) return stop('usage', '--from');
  if (out === undefined) return stop('usage', '--out');
  const criteriaText = values.get('--criteria');
  if (criteriaText !== undefined && from === undefined) return stop('usage', '--criteria');
  const criteria = criteriaText?.split(',').map((id) => id.trim()).filter((id) => id !== '');
  const common = { out, json, ...(from === undefined ? {} : { from }), ...(criteria === undefined ? {} : { criteria }) };
  if (start === undefined) return common;
  // Bounds outside their range are refused before any browser starts, naming the flag.
  const maximumPages = boundOf(values.get('--max-pages'), DEFAULT_EXPLORE_PAGES, 1, MAXIMUM_EXPLORE_PAGES);
  if (maximumPages === undefined) return stop('usage', '--max-pages');
  const maximumDepth = boundOf(values.get('--max-depth'), DEFAULT_EXPLORE_DEPTH, 0, MAXIMUM_EXPLORE_DEPTH);
  if (maximumDepth === undefined) return stop('usage', '--max-depth');
  const after = values.get('--after');
  return { ...common, explore: { start, maximumPages, maximumDepth, host, ...(after === undefined ? {} : { after }) } };
}

// A path inside the project folder, by its forward-slash relative form, or undefined for one that
// is absolute or leads out of the folder.
function insideFolder(folder: string, path: string): string | undefined {
  if (isAbsolute(path)) return undefined;
  const within = relative(folder, resolve(folder, path));
  if (within === '' || within.startsWith('..') || isAbsolute(within)) return undefined;
  return within.replaceAll('\\', '/');
}

// The criteria --criteria names, in the spec's order, or the id it names that the spec lacks.
function chosenCriteria(all: readonly CriterionText[], named: readonly string[] | undefined): readonly CriterionText[] | Stop {
  if (named === undefined) return all;
  const missing = named.find((id) => !all.some((criterion) => criterion.criterion === id));
  if (missing !== undefined || named.length === 0) return stop('usage', '--criteria');
  return all.filter((criterion) => named.includes(criterion.criterion));
}

const isStop = (value: object): value is Stop => 'stopped' in value;

// Everything before the planner call: the trusted project, its planner, the spec's criteria and
// where the draft will go. Checked in this order, so a project without a planner stops before the
// spec is read, and an endpoint off loopback before anything is looked up.
type Prepared = {
  readonly project: TrustedProject;
  readonly endpoint: PlannerEndpoint;
  // The endpoint's origin, the one origin the egress proxy allows.
  readonly origin: Origin;
  readonly request: DraftRequest;
  readonly specPath?: string;
  readonly draftPath: string;
  // In explore mode, where the page map goes: the draft's path with .pages.json for .plan.
  readonly pageMapPath?: string;
};

const unusedPath = (ports: DraftCommandPorts, path: string): boolean => !existsSync(resolve(ports.workingDirectory, path));

// The spec's criteria, or none when there is no spec.
function readCriteria(options: DraftArguments, ports: DraftCommandPorts): { readonly specPath?: string; readonly criteria: readonly CriterionText[] } | Stop {
  if (options.from === undefined) return { criteria: [] };
  const specPath = insideFolder(ports.workingDirectory, options.from);
  if (specPath === undefined) return stop('usage', '--from');
  let spec: string;
  try {
    spec = readFileSync(resolve(ports.workingDirectory, specPath), 'utf8');
  } catch {
    return stop('usage', '--from');
  }
  const extracted = extractCriteria(spec);
  if (!extracted.ok) return stop('usage', '--from');
  const criteria = chosenCriteria(extracted.value, options.criteria);
  return isStop(criteria) ? criteria : { specPath, criteria };
}

async function prepare(options: DraftArguments, ports: DraftCommandPorts): Promise<Prepared | Stop> {
  const loaded = await loadTrustedProject(PROJECT_FILE, ports.versionControl, { files: [], events: ports.events });
  if (!loaded.ok) return stop(loaded.error.code === 'config-invalid' ? 'config-invalid' : 'untrusted-source', PROJECT_FILE);
  const project = loaded.value.project;
  if (project.planner === undefined) return stop('usage', `${PROJECT_FILE}#planner`);
  const endpoint = project.planner;
  if (endpoint.kind === 'local' && !isLoopbackEndpoint(endpoint)) return stop('planner-endpoint-not-loopback', `${PROJECT_FILE}#planner.url`);
  // The project parser has checked the url, so it always has an origin.
  const origin = plannerOrigin(endpoint);
  if (origin === undefined) return stop('config-invalid', `${PROJECT_FILE}#planner.url`);

  // The spec's path is checked before the draft's, as the command line names them.
  if (options.from !== undefined && insideFolder(ports.workingDirectory, options.from) === undefined) return stop('usage', '--from');
  const draftPath = insideFolder(ports.workingDirectory, options.out);
  // A draft is readable text, and never replaces a file already there, such as an approved plan.
  if (draftPath === undefined || !draftPath.endsWith(DRAFT_EXTENSION) || !unusedPath(ports, draftPath)) return stop('usage', '--out');
  const pageMapPath = options.explore === undefined ? undefined : `${draftPath.slice(0, -DRAFT_EXTENSION.length)}${PAGE_MAP_EXTENSION}`;
  if (pageMapPath !== undefined && !unusedPath(ports, pageMapPath)) return stop('usage', '--out');
  const read = readCriteria(options, ports);
  if (isStop(read)) return read;
  const request: DraftRequest = {
    criteria: read.criteria, grammarVersion: READABLE_GRAMMAR_VERSION, origins: project.origins, targets: project.matrix.map((target) => target.id),
  };
  return {
    project, endpoint, origin, request, draftPath,
    ...(read.specPath === undefined ? {} : { specPath: read.specPath }), ...(pageMapPath === undefined ? {} : { pageMapPath }),
  };
}

// Calls the planner through an egress proxy that allows only its origin, and answers with the
// reply as received, or the code the call failed with. The proxy is closed either way.
async function callPlanner(prepared: Prepared, request: DraftRequest, ports: DraftCommandPorts): Promise<{ readonly reply: unknown } | Stop> {
  const { endpoint, origin } = prepared;
  // A local endpoint is a private service on loopback; any other must resolve to a public address.
  const proxy = await startProxyServer(
    { allowedOrigins: [origin], privateOrigins: endpoint.kind === 'local' ? [origin] : [], rewrites: [] },
    { ...(ports.resolve === undefined ? {} : { resolve: ports.resolve }), ...(ports.connect === undefined ? {} : { connect: ports.connect }) },
  );
  try {
    const caller = serviceCaller({ proxy, ...(ports.trustedCertificates === undefined ? {} : { trustedCertificates: ports.trustedCertificates }) });
    const adapter = plannerAdapter(endpoint, origin, { caller, secrets: ports.secrets });
    if (!adapter.ok) return stop('config-invalid', `${PROJECT_FILE}#planner.apiKey`);
    try {
      return { reply: await adapter.value.draft(request) };
    } catch {
      // The adapter's error carries only a code, and none of it is shown: the failure is enough.
      return stop('planner-call-failed', `${PROJECT_FILE}#planner`);
    }
  } finally {
    await proxy.close();
  }
}

// ---- Explore mode ----------------------------------------------------------------------------------

// What a crawl gave: the page map, its file's text, and whether egress was enforced while it ran.
type Explored = { readonly map: PageMap; readonly text: string; readonly egressEnforced: boolean };

// The protected project.json as written, and parsed into the project a run takes.
async function runnableProject(ports: DraftCommandPorts): Promise<{ readonly written: unknown; readonly project: Project } | Stop> {
  const file = await ports.versionControl.protectedFile(PROJECT_FILE);
  if (!file.ok) return stop('untrusted-source', PROJECT_FILE);
  let written: unknown;
  try {
    written = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.value.bytes));
  } catch {
    return stop('config-invalid', PROJECT_FILE);
  }
  const project = parseProject(written);
  return project.ok ? { written, project: project.value } : stop('config-invalid', PROJECT_FILE);
}

type Login = NonNullable<BrowserCrawl['login']> & { readonly text: string };

// The --after plan, read from the working tree, approved for its exact hash on the protected
// branch, and cleared by the policy gate for the crawl's target, all before any browser starts.
// A denial is recorded on the command's audit log.
function clearedLogin(path: string, project: Project, target: Target, ports: DraftCommandPorts): Login | Stop {
  const planPath = insideFolder(ports.workingDirectory, path);
  if (planPath === undefined) return stop('usage', '--after');
  let text: string;
  try {
    text = readFileSync(resolve(ports.workingDirectory, planPath), 'utf8');
  } catch {
    return stop('usage', '--after');
  }
  const read = readPlanText(text, project.limits);
  if (!read.ok) return stop('plan-rejected', '--after');
  const parsed = planParser(project)(read.value.json);
  if (!parsed.ok) return stop('plan-rejected', '--after');
  const standing = planStanding(parsed.value, ports.approvals ?? NO_APPROVALS);
  if (standing.mode !== 'approved') return stop('after-plan-unapproved', '--after');
  if (!parsed.value.targets.includes(target.id)) return stop('plan-rejected', '--after');
  const decision = policyGate({ project, events: ports.events }).decide(parsed.value, [target], standing);
  if (decision.kind === 'deny') return stop('plan-rejected', '--after');
  return { plan: decision.plan, standing, text };
}

const crawlStop = (code: CrawlStop): Stop => stop(code, code === 'plan-rejected' ? '--after' : '--explore');

async function exploreSite(explore: ExploreArguments, prepared: Prepared, ports: DraftCommandPorts): Promise<Explored | Stop> {
  const origin = exploreStartOrigin(prepared.project, explore.start);
  if (origin === undefined) return stop('explore-origin-refused', '--explore');
  const runnable = await runnableProject(ports);
  if (isStop(runnable)) return runnable;
  const { project, written } = runnable;
  const target = crawlTarget(project);
  if (target === undefined) return stop('target-unavailable', `${PROJECT_FILE}#matrix`);
  const login = explore.after === undefined ? undefined : clearedLogin(explore.after, project, target, ports);
  if (login !== undefined && isStop(login)) return login;
  // Page text is redacted of every declared secret, then of personal-data shapes.
  const redactor: Redactor = withDeclaredSecretRedaction(defaultRedactor(), project.secretNames, ports.secrets);
  const bounds = { start: explore.start, maximumPages: explore.maximumPages, maximumDepth: explore.maximumDepth, pageTimeoutMilliseconds: DEFAULT_PAGE_TIMEOUT_MILLISECONDS };

  if (explore.host) {
    if (ports.browser === undefined) return stop('internal', '--host');
    const crawled = await crawlInBrowser(ports.browser, {
      project, target, redactor, secrets: ports.secrets, audit: ports.events, options: { ...bounds, placement: 'host' },
      ...(login === undefined ? {} : { login: { plan: login.plan, standing: login.standing } }),
    });
    return crawled.ok ? { map: crawled.value, text: pageMapText(crawled.value), egressEnforced: false } : crawlStop(crawled.error);
  }
  if (ports.isolatedRunner === undefined) return stop('explore-runner-unavailable', '--explore');
  const input = { project: written, ...bounds, ...(login === undefined ? {} : { afterPlan: login.text }) };
  const crawled = await crawlInRunner(ports.isolatedRunner, input, origin, project.secretNames, redactor);
  return crawled.ok ? { map: crawled.value, text: pageMapText(crawled.value), egressEnforced: true } : crawlStop(crawled.error);
}

// ---- The draft -------------------------------------------------------------------------------------

type Drafted = { readonly result: DraftCommandResult; readonly crawledOrigin?: string; readonly calledOrigins: readonly string[] };

// Writes a file that must not exist yet, its folder made first.
function writeNew(ports: DraftCommandPorts, path: string, content: string): boolean {
  const absolute = resolve(ports.workingDirectory, path);
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

async function draft(options: DraftArguments, ports: DraftCommandPorts): Promise<Drafted | Stop> {
  const prepared = await prepare(options, ports);
  if (isStop(prepared)) return prepared;
  const { project, endpoint, origin, draftPath, pageMapPath } = prepared;
  const explored = options.explore === undefined ? undefined : await exploreSite(options.explore, prepared, ports);
  if (explored !== undefined && isStop(explored)) return explored;
  const request: DraftRequest = explored === undefined ? prepared.request : { ...prepared.request, pages: explored.map.pages };
  const called = await callPlanner(prepared, request, ports);
  if (isStop(called)) return called;

  // The reply is outside input: decoded by the engine, then bounded as text no longer than the
  // largest plan the project allows. Anything else is refused whole, and nothing of it is shown.
  const replyText = plannerReplyText(endpoint.wire, called.reply);
  if (!replyText.ok) return stop('plan-rejected', draftPath);
  const text = parseAiText(replyText.value, project.limits.maximumPlanBytes);
  if (!text.ok) return stop('plan-rejected', draftPath);

  // An explore draft opens with the command's notice, so the model's text cannot replace it, and
  // the lines of its errors and warnings count it.
  const content = explored === undefined ? text.value : `${EXPLORE_NOTICE}${text.value}`;
  const reference = explored === undefined ? prepared.specPath : pageMapReference(explored.text);
  const source: Extract<PlanSource, 'draft-command' | 'explore-draft'> = explored === undefined ? 'draft-command' : 'explore-draft';
  const drafted: PlanDraft = { format: 'text', content };
  const admitted = admitCoreDraft(drafted, { source, ...(reference === undefined ? {} : { reference }) }, planParser(project), ports.events);
  const provenance: PlanProvenance = { source, basis: 'core-recorded', ...(reference === undefined ? {} : { reference }) };
  let warnings: readonly DraftWarning[] = [];
  if (explored !== undefined && admitted.ok) {
    const reading = readPlanText(content, project.limits);
    if (reading.ok) warnings = checkDraftLocators(admitted.value, reading.value, explored.map);
  }
  // A draft with errors is still written, so a person can fix it; its errors point at its lines.
  if (explored !== undefined && pageMapPath !== undefined && !writeNew(ports, pageMapPath, explored.text)) return stop('internal', pageMapPath);
  if (!writeNew(ports, draftPath, content)) return stop('internal', draftPath);
  const result: DraftCommandResult = {
    draftPath, provenance, errors: admitted.ok ? [] : admitted.error, approved: false,
    ...(explored === undefined || pageMapPath === undefined ? {} : { pageMapPath }),
    warnings,
    ...(explored === undefined ? {} : { egressEnforced: explored.egressEnforced }),
  };
  return { result, ...(explored === undefined ? {} : { crawledOrigin: explored.map.origin }), calledOrigins: [origin] };
}

// The human-readable account of a draft, one fact per line.
function draftReport(result: DraftCommandResult): string {
  const lines = [`Draft written to ${result.draftPath}, unapproved, source ${result.provenance.source}.`];
  if (result.pageMapPath !== undefined) lines.push(`Page map written to ${result.pageMapPath}.`);
  if (result.egressEnforced === false) lines.push('Egress was not enforced: the crawl ran in a browser on this machine (--host).');
  for (const error of result.errors) {
    lines.push(error.position === null ? `  ${error.code}` : `  line ${error.position.line}, column ${error.position.column}: ${error.code}`);
  }
  for (const warning of result.warnings) lines.push(`  line ${warning.position.line}, column ${warning.position.column}: ${warning.code} (warning)`);
  return `${lines.join('\n')}\n`;
}

export async function draftCommand(argv: readonly string[], ports: DraftCommandPorts): Promise<CommandOutcome> {
  const json = argv.includes('--json');
  const options = readArguments(argv);
  const outcome = isStop(options) ? options : await draft(options, ports);
  if (isStop(outcome)) {
    const output: CliOutput<DraftCommandData> = { schema: CLI_OUTPUT_SCHEMA, command: 'draft', ok: false, errors: [outcome.stopped] };
    const where = outcome.stopped.path === undefined ? '' : ` at ${outcome.stopped.path}`;
    return {
      exitCode: exitCodeFor(outcome.stopped.code),
      stdout: json ? `${JSON.stringify(output, null, 2)}\n` : '',
      stderr: json ? '' : `draft: ${outcome.stopped.code}${where} (see docs/errors.md#${outcome.stopped.code})\n`,
    };
  }
  const data: DraftCommandData = {
    ...outcome.result, ...(outcome.crawledOrigin === undefined ? {} : { crawledOrigin: outcome.crawledOrigin }), calledOrigins: outcome.calledOrigins,
  };
  const output: CliOutput<DraftCommandData> = { schema: CLI_OUTPUT_SCHEMA, command: 'draft', ok: true, data };
  return { exitCode: 0, stdout: json ? `${JSON.stringify(output, null, 2)}\n` : draftReport(outcome.result), stderr: '' };
}
