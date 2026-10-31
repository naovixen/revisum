// The draft command (route c):
//   revisum draft --from <spec.md> [--criteria AC-1,AC-3] --out plans/<name>.plan [--json]
// It reads the spec's acceptance criteria, sends only them, the readable grammar's version and the
// project's declared origins and targets to the project's planner, and writes the planner's text
// as an unapproved readable draft, with its errors by line. It never approves or runs the draft:
// what it hands on is a PlanDraft, which only the engine's admitDraft door turns into a Plan, and
// the lint keeps the engine's run function out of this module.
//
// The planner endpoint is read from the protected branch's project.json, never the working tree's,
// so a change under test cannot send the key elsewhere. The call goes through runner's service
// caller behind an in-process egress proxy that allows only the planner's origin; a local
// endpoint must be on loopback. Output that is not text, looks like script or is too long writes
// no draft and reports plan-rejected.
// See docs/specs/SPEC-28-plan-authoring.md and docs/specs/SPEC-16-cli-and-github-action.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  READABLE_GRAMMAR_VERSION, admitCoreDraft, extractCriteria, loadTrustedProject, parseAiText, planParser, plannerOrigin, plannerReplyText,
  type CliErrorCode, type CriterionText, type DraftError, type DraftRequest, type EventSink, type Origin, type PlanDraft, type PlannerEndpoint,
  type PlanProvenance, type SecretStore, type TrustedProject, type VersionControlPort,
} from '@revisum/engine';
import { serviceCaller, startProxyServer, type AddressConnector, type AddressResolver } from '@revisum/runner';
import { CLI_OUTPUT_SCHEMA, cliError, exitCodeFor, type CliError, type CliOutput, type CommandOutcome } from './cli-output.ts';
import { isLoopbackEndpoint, plannerAdapter } from './planner-adapters.ts';

export type DraftCommandPorts = {
  // The project folder: --from and --out are relative to it.
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
};

// What the command reports for a written draft. The draft is never approved by the command.
export type DraftCommandResult = {
  readonly draftPath: string;
  readonly provenance: PlanProvenance;
  readonly errors: readonly DraftError[];
  readonly approved: false;
};
// With --json, the result and the planner origins the command called, as the record of its egress.
export type DraftCommandData = DraftCommandResult & { readonly calledOrigins: readonly string[] };

const PROJECT_FILE = 'project.json';
const DRAFT_EXTENSION = '.plan';

type DraftArguments = { readonly from: string; readonly out: string; readonly criteria?: readonly string[]; readonly json: boolean };

// A failure the command stops with: its code and, when it helps, where.
type Stop = { readonly stopped: CliError };
const stop = (code: CliErrorCode, path?: string): Stop => ({ stopped: cliError(code, path) });

function readArguments(argv: readonly string[]): DraftArguments | Stop {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const word = argv[index];
    if (word === '--json') { json = true; continue; }
    if (word !== '--from' && word !== '--out' && word !== '--criteria') return stop('usage', word);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--') || values.has(word)) return stop('usage', word);
    values.set(word, value);
    index += 1;
  }
  const from = values.get('--from');
  const out = values.get('--out');
  if (from === undefined) return stop('usage', '--from');
  if (out === undefined) return stop('usage', '--out');
  const criteria = values.get('--criteria')?.split(',').map((id) => id.trim()).filter((id) => id !== '');
  return { from, out, json, ...(criteria === undefined ? {} : { criteria }) };
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
  readonly specPath: string;
  readonly draftPath: string;
};

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

  const specPath = insideFolder(ports.workingDirectory, options.from);
  if (specPath === undefined) return stop('usage', '--from');
  const draftPath = insideFolder(ports.workingDirectory, options.out);
  // A draft is readable text, and never replaces a file already there, such as an approved plan.
  if (draftPath === undefined || !draftPath.endsWith(DRAFT_EXTENSION) || existsSync(resolve(ports.workingDirectory, draftPath))) return stop('usage', '--out');
  let spec: string;
  try {
    spec = readFileSync(resolve(ports.workingDirectory, specPath), 'utf8');
  } catch {
    return stop('usage', '--from');
  }
  const extracted = extractCriteria(spec);
  if (!extracted.ok) return stop('usage', '--from');
  const criteria = chosenCriteria(extracted.value, options.criteria);
  if (isStop(criteria)) return criteria;
  const request: DraftRequest = {
    criteria, grammarVersion: READABLE_GRAMMAR_VERSION, origins: project.origins, targets: project.matrix.map((target) => target.id),
  };
  return { project, endpoint, origin, request, specPath, draftPath };
}

// Calls the planner through an egress proxy that allows only its origin, and answers with the
// reply as received, or the code the call failed with. The proxy is closed either way.
async function callPlanner(prepared: Prepared, ports: DraftCommandPorts): Promise<{ readonly reply: unknown } | Stop> {
  const { endpoint, origin, request } = prepared;
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

type Drafted = { readonly result: DraftCommandResult; readonly calledOrigins: readonly string[] };

async function draft(options: DraftArguments, ports: DraftCommandPorts): Promise<Drafted | Stop> {
  const prepared = await prepare(options, ports);
  if (isStop(prepared)) return prepared;
  const { project, endpoint, origin, specPath, draftPath } = prepared;
  const called = await callPlanner(prepared, ports);
  if (isStop(called)) return called;

  // The reply is outside input: decoded by the engine, then bounded as text no longer than the
  // largest plan the project allows. Anything else is refused whole, and nothing of it is shown.
  const replyText = plannerReplyText(endpoint.wire, called.reply);
  if (!replyText.ok) return stop('plan-rejected', draftPath);
  const text = parseAiText(replyText.value, project.limits.maximumPlanBytes);
  if (!text.ok) return stop('plan-rejected', draftPath);

  const drafted: PlanDraft = { format: 'text', content: text.value };
  const admitted = admitCoreDraft(drafted, { source: 'draft-command', reference: specPath }, planParser(project), ports.events);
  const provenance: PlanProvenance = { source: 'draft-command', basis: 'core-recorded', reference: specPath };
  // A draft with errors is still written, so a person can fix it; its errors point at its lines.
  const absolute = resolve(ports.workingDirectory, draftPath);
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, drafted.content, { encoding: 'utf8', flag: 'wx' });
  } catch {
    return stop('internal', draftPath);
  }
  return { result: { draftPath, provenance, errors: admitted.ok ? [] : admitted.error, approved: false }, calledOrigins: [origin] };
}

// The human-readable account of a draft, one fact per line.
function draftReport(result: DraftCommandResult): string {
  const lines = [`Draft written to ${result.draftPath}, unapproved, source ${result.provenance.source}.`];
  for (const error of result.errors) {
    lines.push(error.position === null ? `  ${error.code}` : `  line ${error.position.line}, column ${error.position.column}: ${error.code}`);
  }
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
  const data: DraftCommandData = { ...outcome.result, calledOrigins: outcome.calledOrigins };
  const output: CliOutput<DraftCommandData> = { schema: CLI_OUTPUT_SCHEMA, command: 'draft', ok: true, data };
  return { exitCode: 0, stdout: json ? `${JSON.stringify(output, null, 2)}\n` : draftReport(outcome.result), stderr: '' };
}
