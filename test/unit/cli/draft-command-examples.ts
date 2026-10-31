// Shared setup for the tests of the draft command (route c) and the planner adapters behind it.
//
//   - draftWorkspace() builds a throw-away project folder: the protected branch's project.json,
//     with the planner endpoint the test names, served through a fake VersionControlPort; a
//     working-tree project.json, the same unless a test plants another; the sign-up spec under
//     specs/, a trusted plan already in plans/ and an artefact from an earlier run, so a test can
//     show none of them reaches the planner;
//   - startFakePlanner() is a local planner over HTTP, or over HTTPS with the test certificate in
//     fixtures/draft-command/planner-tls/ (valid for planner.test for a hundred years), answering
//     every request with a recorded planner reply, one per wire format, and recording each
//     request and connection it receives;
//   - runDraft() runs the draft command against them, with a real in-process egress proxy, and
//     gathers everything it wrote: its outcome, the console, the audit events and the draft file.
//
// What these tests assume about shapes the spec leaves open, gathered here so a change to one is
// a change to this file only (docs/specs/SPEC-28-plan-authoring.md, "`draft` and the planner
// adapters" under "Milestone"):
//   - cli exports draftCommand(argv, ports), where argv holds the arguments after the word
//     "draft" and ports are DraftCommandPorts below. It answers with the exit code and the text it
//     would print on standard output and standard error;
//   - the command reads the trusted project.json from the protected branch through
//     ports.versionControl, as the run's trust step does (loadTrustedProject), never from the
//     working tree; it reads the spec and writes --out relative to ports.workingDirectory, and
//     appends its audit events to ports.events;
//   - ports.resolve and ports.connect, when given, are handed to the egress proxy the command
//     starts (runner's ProxyServerOptions), so a test reaches a fake planner on a made-up host
//     without the network. Without them the proxy resolves and connects for real;
//   - ports.trustedCertificates, a test-only option, holds PEM certificates the caller trusts for
//     HTTPS through the proxy's CONNECT tunnel, besides the system's own;
//   - a customer-key endpoint must be https:, refused by the project parser otherwise; a local
//     endpoint, on loopback only, may be http:;
//   - the endpoint's `url` is the full address the request is posted to;
//   - a spec's criteria are "- <id>: <text>" items under an "## Acceptance criteria" heading;
//   - --json prints one CliOutput whose data is the DraftCommandResult, plus the planner origin
//     the command called, under a field the spec does not name.
// See docs/specs/SPEC-28-plan-authoring.md and docs/specs/SPEC-37-explore-to-draft.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp, type Socket } from 'node:net';
import { failure, success, type EventSink, type SecretStore, type VersionControlPort } from '@revisum/contracts';
import { environmentSecretStore } from '@revisum/engine';
import type { AddressConnector, AddressResolver } from '@revisum/runner';
import { FIXTURES, GOLDEN } from '../../support/repository.ts';
import { memoryEventSink, type MemoryEventSink } from '../../support/memory-ports.ts';
import { consoleWrittenDuring, jsonAnswer, type Answer, type Dialled, type ReceivedRequest } from '../runner/local-service.ts';
import { fakeResolver, type FakeResolver } from '../runner/runner-examples.ts';
import { fakeSecretValue } from '../engine/secret-examples.ts';

// ---- The command's assumed shape -----------------------------------------------------------------

export type DraftCommandPorts = {
  readonly workingDirectory: string;
  readonly secrets: SecretStore;
  readonly events: EventSink;
  // The protected branch, where the trusted project.json is read.
  readonly versionControl: VersionControlPort;
  readonly resolve?: AddressResolver;
  readonly connect?: AddressConnector;
  readonly trustedCertificates?: readonly string[];
};
export type CommandOutcome = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
export type DraftCommand = (argv: readonly string[], ports: DraftCommandPorts) => Promise<CommandOutcome>;

// The draft command, looked up at run time so these tests compile before it exists. A missing
// export fails each test loudly, naming it.
export async function loadDraftCommand(): Promise<DraftCommand> {
  const loaded: unknown = await import('@revisum/cli');
  const exported: unknown = typeof loaded === 'object' && loaded !== null ? Object.getOwnPropertyDescriptor(loaded, 'draftCommand')?.value : undefined;
  if (typeof exported !== 'function') throw new Error('@revisum/cli does not export a function named draftCommand');
  return async (argv, ports) => {
    const outcome: unknown = await Reflect.apply(exported, undefined, [argv, ports]);
    assert.ok(typeof outcome === 'object' && outcome !== null, 'draftCommand answered with no outcome');
    const exitCode: unknown = Reflect.get(outcome, 'exitCode');
    const stdout: unknown = Reflect.get(outcome, 'stdout');
    const stderr: unknown = Reflect.get(outcome, 'stderr');
    assert.equal(typeof exitCode, 'number', 'the outcome has no numeric exitCode');
    assert.equal(typeof stdout, 'string', 'the outcome has no stdout text');
    assert.equal(typeof stderr, 'string', 'the outcome has no stderr text');
    return { exitCode: Number(exitCode), stdout: String(stdout), stderr: String(stderr) };
  };
}

// ---- The project ---------------------------------------------------------------------------------

export const APP_ORIGIN = 'http://127.0.0.1:4173';
export const SECOND_APP_ORIGIN = 'http://127.0.0.1:4175';
export const TARGET = 'chromium-stable';
export const GRAMMAR_VERSION = 'v1';
// A secret the project declares for its plans, and the planner's key.
export const DECLARED_SECRET = 'SIGNUP_PASSWORD';
export const PLANNER_KEY_NAME = 'PLANNER_API_KEY';

// The host a customer-key planner is declared on. It resolves only through the test's fake
// resolver, so a request that went round the egress proxy could never reach the fake planner.
export const PLANNER_HOST = 'planner.test';
export const PLANNER_ORIGIN = `https://${PLANNER_HOST}`;
// What the fake resolver answers for PLANNER_HOST: a public address, which the proxy allows.
export const PUBLIC_ADDRESS = '93.184.215.14';

export const WIRE_FORMATS = ['anthropic-messages', 'openai-chat'] as const;
export type WireFormat = (typeof WIRE_FORMATS)[number];

// The path each wire format is posted to, and the model a customer-key endpoint names.
export const WIRE_PATHS: { readonly [Wire in WireFormat]: string } = { 'anthropic-messages': '/v1/messages', 'openai-chat': '/v1/chat/completions' };
export const WIRE_MODELS: { readonly [Wire in WireFormat]: string } = { 'anthropic-messages': 'claude-test-model', 'openai-chat': 'gpt-test-model' };
export const LOCAL_MODEL = 'llama-test';

export type JsonRecord = Record<string, unknown>;

// A planner on the customer's own key, on PLANNER_HOST over HTTPS unless `origin` says otherwise.
export const customerKeyPlanner = (wire: WireFormat, origin: string = PLANNER_ORIGIN): JsonRecord => ({
  kind: 'customer-key', url: `${origin}${WIRE_PATHS[wire]}`, model: WIRE_MODELS[wire], wire, apiKey: { secretName: PLANNER_KEY_NAME },
});

// A local planner with no key at `origin`, such as Ollama on loopback.
export const localPlanner = (origin: string, wire: WireFormat = 'openai-chat'): JsonRecord => ({
  kind: 'local', url: `${origin}${WIRE_PATHS[wire]}`, model: LOCAL_MODEL, wire,
});

// The trusted project: two origins, one target, a declared secret and, when given, the planner.
export const projectFile = (planner: JsonRecord | undefined): JsonRecord => ({
  origins: [APP_ORIGIN, SECOND_APP_ORIGIN],
  matrix: [{
    id: TARGET, adapter: 'playwright', engine: 'chromium', device: 'desktop-1280', locale: 'en-GB',
    timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
  }],
  secretNames: [DECLARED_SECRET, PLANNER_KEY_NAME],
  ...(planner === undefined ? {} : { planner }),
});

// ---- The spec ------------------------------------------------------------------------------------

export const SPEC_PATH = 'specs/signup.md';
export const DRAFT_PATH = 'plans/signup.plan';
export const SIGNUP_SPEC = readFileSync(join(FIXTURES, 'draft-command', 'signup-spec.md'), 'utf8');

// The three criteria texts of the sign-up spec, as written after their ids.
export const CRITERION_TEXTS = {
  emailAccepted: 'When a visitor submits a valid email address, the page shall show the heading "Welcome".',
  addressTaken: 'When the email address is already registered, the page shall say "That address is taken".',
  buttonDisabled: 'When the email field is empty, the "Create account" button shall stay disabled.',
} as const;
// Text in the spec outside its criteria: the planner must never see it.
export const BACKGROUND_NOTE = 'BACKGROUND-ONLY-NOTE-7Q4';
export const NOTES_ARTEFACT = 'signup-review-sheet.png';

// An artefact an earlier run left in the project folder, by path and by a word of its name.
export const EARLIER_ARTEFACT = '.revisum/artifacts/run-earlier-kept/screenshot-after-signup.png';
export const EARLIER_ARTEFACT_MARK = 'run-earlier-kept';

// A plan already approved in plans/, a trusted file the command must leave alone.
export const EXISTING_PLAN_PATH = 'plans/sign-in.plan';
const EXISTING_PLAN = readFileSync(join(FIXTURES, 'readable-plans', 'sign-in.plan'), 'utf8');

// The draft command's arguments: --from the spec, --out the draft, then `extra`.
export const draftArguments = (extra: readonly string[] = ['--json']): readonly string[] =>
  ['--from', SPEC_PATH, '--out', DRAFT_PATH, ...extra];

// ---- The recorded planner replies ----------------------------------------------------------------

export const GOLDEN_DRAFT = readFileSync(join(GOLDEN, 'drafts', 'signup.plan'), 'utf8');

const replyFile = (wire: WireFormat): string => join(FIXTURES, 'draft-command', `${wire}-reply.json`);

// The reply each wire format's planner sent, as recorded. Its text is the golden draft.
export function recordedReply(wire: WireFormat): JsonRecord {
  const parsed: unknown = JSON.parse(readFileSync(replyFile(wire), 'utf8'));
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), `${replyFile(wire)} is not a JSON object`);
  return { ...parsed };
}

// The recorded reply with its text, or the whole value where the text stands, replaced.
export function replyWithContent(wire: WireFormat, content: unknown): JsonRecord {
  const reply = recordedReply(wire);
  if (wire === 'anthropic-messages') return { ...reply, content: [{ type: 'text', text: content }] };
  return { ...reply, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }] };
}

// A reply that carries no text at all: a tool call in place of the text.
export function replyWithoutText(wire: WireFormat): JsonRecord {
  const reply = recordedReply(wire);
  if (wire === 'anthropic-messages') {
    return { ...reply, content: [{ type: 'tool_use', id: 'tool-use-1', name: 'write_plan', input: { steps: [] } }], stop_reason: 'tool_use' };
  }
  return {
    ...reply,
    choices: [{
      index: 0, finish_reason: 'tool_calls',
      message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'write_plan', arguments: '{}' } }] },
    }],
  };
}

// The golden draft with one line replaced, and the 1-based line it stands on.
export function draftWithLine(find: string, replacement: string): { readonly text: string; readonly line: number } {
  const lines = GOLDEN_DRAFT.split('\n');
  const index = lines.indexOf(find);
  assert.ok(index !== -1, `the golden draft has no line ${find}`);
  lines[index] = replacement;
  return { text: lines.join('\n'), line: index + 1 };
}

// ---- The workspace ---------------------------------------------------------------------------------

export type DraftWorkspace = {
  readonly root: string;
  // The project.json the protected branch holds, which the command must trust.
  readonly protectedProject: JsonRecord;
  write(relativePath: string, content: string | Uint8Array): void;
  read(relativePath: string): string;
  exists(relativePath: string): boolean;
  remove(relativePath: string): void;
  // Every file under the root, by forward-slash relative path, with the sha256 of its bytes.
  snapshot(): ReadonlyMap<string, string>;
  dispose(): void;
};

export type WorkspaceOptions = {
  // The planner endpoint the protected project.json declares; none when undefined.
  readonly planner: JsonRecord | undefined;
  // The working tree's own project.json, as a change under test may have edited it; the
  // protected one unless given.
  readonly workingTreeProject?: JsonRecord;
  // The spec's text; the sign-up spec unless given.
  readonly spec?: string;
};

export function draftWorkspace(options: WorkspaceOptions): DraftWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'revisum-draft-'));
  const write = (relativePath: string, content: string | Uint8Array): void => {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const protectedProject = projectFile(options.planner);
  write('project.json', `${JSON.stringify(options.workingTreeProject ?? protectedProject, null, 2)}\n`);
  write(SPEC_PATH, options.spec ?? SIGNUP_SPEC);
  write(EXISTING_PLAN_PATH, EXISTING_PLAN);
  write(EARLIER_ARTEFACT, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const snapshot = (): ReadonlyMap<string, string> => {
    const files = new Map<string, string>();
    const visit = (relative: string): void => {
      for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
        const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile()) files.set(path, createHash('sha256').update(readFileSync(join(root, path))).digest('hex'));
      }
    };
    visit('');
    return files;
  };
  return {
    root,
    protectedProject,
    write,
    read: (relativePath) => readFileSync(join(root, relativePath), 'utf8'),
    exists: (relativePath) => existsSync(join(root, relativePath)),
    remove: (relativePath) => rmSync(join(root, relativePath), { force: true }),
    snapshot,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

// A protected branch that holds just `project` as project.json, as the run's trust step reads it.
// Every other question is unavailable: the draft command needs no review or pull request.
export function protectedBranchWith(project: JsonRecord): VersionControlPort {
  return {
    protectedBranch: 'main',
    async protectedFile(path) {
      return path === 'project.json'
        ? success({ bytes: new TextEncoder().encode(JSON.stringify(project)), commit: 'commit-protected' })
        : failure('not-found');
    },
    reviews: async () => failure('unavailable'),
    changedFiles: async () => failure('unavailable'),
    pullRequest: async () => failure('unavailable'),
    lastCommitTouching: async () => failure('unavailable'),
    landedBy: async () => failure('unavailable'),
  };
}

// ---- The fake planner -------------------------------------------------------------------------------

const TLS_FOLDER = join(FIXTURES, 'draft-command', 'planner-tls');
// The test certificate a fake HTTPS planner serves, valid for PLANNER_HOST. The caller trusts it
// only when it is passed as one of ports.trustedCertificates.
export const TEST_CERTIFICATE = readFileSync(join(TLS_FOLDER, 'certificate.pem'), 'utf8');
const TEST_PRIVATE_KEY = readFileSync(join(TLS_FOLDER, 'private-key.pem'), 'utf8');

export type FakePlanner = {
  // http://127.0.0.1:<port>, or https:// for a secure planner.
  readonly origin: string;
  // Every request received, in order, recorded once its body has arrived.
  readonly received: readonly ReceivedRequest[];
  // Every address and port the proxy asked for, when its connections are routed here.
  readonly dialled: readonly Dialled[];
  // How many TCP connections reached the planner, from anyone.
  connections(): number;
  // A connect function for the proxy: records the vetted address, then connects here instead.
  connect(address: string, port: number): Socket;
  close(): Promise<void>;
};

// A planner on loopback that answers every request as `answer` says, over HTTPS with the test
// certificate when `secure` is true.
export async function startFakePlanner(answer: Answer, secure = false): Promise<FakePlanner> {
  const received: ReceivedRequest[] = [];
  const dialled: Dialled[] = [];
  let connections = 0;
  const handle = (incoming: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
    incoming.on('end', () => {
      const request: ReceivedRequest = {
        method: incoming.method ?? '', path: incoming.url ?? '', headers: incoming.headers, body: Buffer.concat(chunks).toString('utf8'),
      };
      const earlier = [...received];
      received.push(request);
      answer(request, response, earlier);
    });
  };
  const server = secure ? createHttpsServer({ cert: TEST_CERTIFICATE, key: TEST_PRIVATE_KEY }, handle) : createHttpServer(handle);
  server.on('connection', () => { connections += 1; });
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(typeof address === 'object' && address !== null, 'the fake planner has no address');
  const port = address.port;
  return {
    origin: `${secure ? 'https' : 'http'}://127.0.0.1:${port}`,
    received,
    dialled,
    connections: () => connections,
    connect(vettedAddress, vettedPort) {
      dialled.push({ address: vettedAddress, port: vettedPort });
      return connectTcp(port, '127.0.0.1');
    },
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export const recordedAnswer = (wire: WireFormat): Answer => jsonAnswer(200, recordedReply(wire));

// ---- Running the command ---------------------------------------------------------------------------

export type DraftRun = {
  readonly outcome: CommandOutcome;
  // Everything the process wrote to stdout and stderr while the command ran.
  readonly printed: string;
  readonly events: MemoryEventSink;
  readonly resolver: FakeResolver;
  // The --json output, parsed; undefined when stdout is not JSON.
  readonly output: JsonRecord | undefined;
};

export type RunOptions = {
  readonly workspace: DraftWorkspace;
  // The planner the egress proxy's connections go to, whatever address it vetted. Without one the
  // proxy connects for real, as it does to a local planner on loopback. The test certificate is
  // always among the trusted ones.
  readonly routeTo?: FakePlanner;
  // What the fake resolver answers; PLANNER_HOST resolves to PUBLIC_ADDRESS unless given.
  readonly names?: Readonly<Record<string, readonly string[]>>;
  readonly argv?: readonly string[];
  // The secret store's variables; the declared secret and the planner key, fresh, unless given.
  readonly secrets?: Readonly<Record<string, string>>;
};

export type SeededSecrets = { readonly plannerKey: string; readonly declaredSecret: string; readonly variables: Readonly<Record<string, string>> };

export function seededSecrets(): SeededSecrets {
  const plannerKey = fakeSecretValue();
  const declaredSecret = fakeSecretValue();
  return { plannerKey, declaredSecret, variables: { [PLANNER_KEY_NAME]: plannerKey, [DECLARED_SECRET]: declaredSecret } };
}

const parsedOutput = (stdout: string): JsonRecord | undefined => {
  try {
    const parsed: unknown = JSON.parse(stdout);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : undefined;
  } catch {
    return undefined;
  }
};

export async function runDraft(options: RunOptions): Promise<DraftRun> {
  const command = await loadDraftCommand();
  const events = memoryEventSink();
  const resolver = fakeResolver(options.names ?? { [PLANNER_HOST]: [PUBLIC_ADDRESS] });
  const routeTo = options.routeTo;
  const ports: DraftCommandPorts = {
    workingDirectory: options.workspace.root,
    secrets: environmentSecretStore(options.secrets ?? seededSecrets().variables),
    events,
    versionControl: protectedBranchWith(options.workspace.protectedProject),
    trustedCertificates: [TEST_CERTIFICATE],
    ...(routeTo === undefined ? {} : { resolve: resolver.resolve, connect: (address: string, port: number) => routeTo.connect(address, port) }),
  };
  let outcome: CommandOutcome | undefined;
  const printed = await consoleWrittenDuring(async () => { outcome = await command(options.argv ?? draftArguments(), ports); });
  assert.ok(outcome !== undefined, 'the draft command gave no outcome');
  return { outcome, printed, events, resolver, output: parsedOutput(outcome.stdout) };
}

// Starts a fake planner, runs the command against it in a fresh workspace, then closes both. A
// routed planner is an HTTPS one, as a customer-key endpoint is; an unrouted one is plain HTTP
// on loopback, as a local endpoint may be.
export type PlannedRun = DraftRun & { readonly planner: FakePlanner; readonly workspace: DraftWorkspace };

export async function withPlannedRun(
  setup: { readonly planner: (fake: FakePlanner) => JsonRecord | undefined; readonly answer: Answer; readonly routed: boolean } & Omit<RunOptions, 'workspace' | 'routeTo'>
    & { readonly spec?: string },
  body: (run: PlannedRun) => Promise<void> | void,
): Promise<void> {
  const planner = await startFakePlanner(setup.answer, setup.routed);
  const workspace = draftWorkspace({ planner: setup.planner(planner), ...(setup.spec === undefined ? {} : { spec: setup.spec }) });
  try {
    const run = await runDraft({ ...setup, workspace, ...(setup.routed ? { routeTo: planner } : {}) });
    await body({ ...run, planner, workspace });
  } finally {
    await planner.close();
    workspace.dispose();
  }
}

// ---- Reading what the command did ---------------------------------------------------------------------

// The --json output's data, which a test needs to exist.
export function outputData(run: DraftRun): JsonRecord {
  assert.ok(run.output !== undefined, `stdout is not one JSON object:\n${run.outcome.stdout}`);
  const data = run.output['data'];
  assert.ok(typeof data === 'object' && data !== null && !Array.isArray(data), `the output has no data object: ${run.outcome.stdout}`);
  return { ...data };
}

// The codes of the --json output's errors.
export function outputErrorCodes(run: DraftRun): readonly string[] {
  assert.ok(run.output !== undefined, `stdout is not one JSON object:\n${run.outcome.stdout}`);
  const errors = run.output['errors'];
  if (!Array.isArray(errors)) return [];
  return errors.map((error: unknown) => (typeof error === 'object' && error !== null ? String(Reflect.get(error, 'code')) : ''));
}

// Every string anywhere in a JSON value.
export function stringsIn(value: unknown): readonly string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

// The one request the fake planner received.
export function onlyRequest(planner: FakePlanner): ReceivedRequest {
  assert.equal(planner.received.length, 1, `the planner received ${planner.received.length} requests`);
  const request = planner.received[0];
  assert.ok(request !== undefined);
  return request;
}

// Every text the command's run left behind, for leak scans: its outcome, the console, the audit
// events and every file it wrote or changed in the workspace.
export function everythingWritten(run: PlannedRun, before: ReadonlyMap<string, string> = new Map()): string {
  const changedFiles = [...run.workspace.snapshot()].filter(([path, hash]) => before.get(path) !== hash).map(([path]) => run.workspace.read(path));
  return [run.outcome.stdout, run.outcome.stderr, run.printed, JSON.stringify(run.events.recorded), ...changedFiles].join('\n');
}

// The request body as JSON.
export function requestBody(request: ReceivedRequest): JsonRecord {
  const parsed: unknown = JSON.parse(request.body);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed), `the request body is not a JSON object: ${request.body}`);
  return { ...parsed };
}

// The prompt texts of a request, in order: Anthropic's system text then each message's content;
// for the OpenAI-compatible format, each message's content.
export function promptTexts(body: JsonRecord): readonly string[] {
  const texts: string[] = [];
  const system = body['system'];
  if (typeof system === 'string') texts.push(system);
  const messages = body['messages'];
  if (Array.isArray(messages)) {
    for (const message of messages) {
      const content: unknown = typeof message === 'object' && message !== null ? Reflect.get(message, 'content') : undefined;
      if (typeof content === 'string') texts.push(content);
    }
  }
  return texts;
}

export const PROMPT_PLACEHOLDER = '<prompt>';

// The body with every prompt text replaced by PROMPT_PLACEHOLDER, as the golden bodies hold it:
// the prompt is the engine's fixed text, compared between wire formats rather than pinned here.
export function withPromptsReplaced(body: JsonRecord): JsonRecord {
  const replaced: JsonRecord = { ...body };
  if (typeof replaced['system'] === 'string') replaced['system'] = PROMPT_PLACEHOLDER;
  const messages = replaced['messages'];
  if (Array.isArray(messages)) {
    replaced['messages'] = messages.map((message: unknown) => {
      if (typeof message !== 'object' || message === null) return message;
      const copy: JsonRecord = { ...message };
      if (typeof copy['content'] === 'string') copy['content'] = PROMPT_PLACEHOLDER;
      return copy;
    });
  }
  return replaced;
}

export type GoldenRequest = { readonly method: string; readonly path: string; readonly headers: Readonly<Record<string, string>>; readonly body: JsonRecord };

export function goldenRequest(wire: WireFormat): GoldenRequest {
  const parsed: unknown = JSON.parse(readFileSync(join(GOLDEN, 'planner-requests', `${wire}.json`), 'utf8'));
  assert.ok(typeof parsed === 'object' && parsed !== null);
  const method = Reflect.get(parsed, 'method');
  const path = Reflect.get(parsed, 'path');
  const headers: unknown = Reflect.get(parsed, 'headers');
  const body: unknown = Reflect.get(parsed, 'body');
  assert.ok(typeof method === 'string' && typeof path === 'string');
  assert.ok(typeof headers === 'object' && headers !== null && typeof body === 'object' && body !== null);
  return { method, path, headers: Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, String(value)])), body: { ...body } };
}

// The value of one header the planner received, as a single string.
export function headerValue(request: ReceivedRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(', ') : value;
}
