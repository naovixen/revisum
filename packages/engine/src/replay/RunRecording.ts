// Recorded replies: what a run's declared services answered and its database commands printed,
// kept so a replay can feed the same replies to the engine without sending a call or running a
// command. The result keeps only hashes of replies, so they are recorded apart from it, and only
// when the trusted project sets replay.recordReplies: replies may hold personal data, which nothing
// masks until privacy masking.
//   - recordingPorts wraps a run's service caller and command runner: each reply is kept, in
//     order, with its request's sha256 (a secret counts by name only), and recording() makes the
//     RunRecording once the run's manifest hash is known. Every echo of a secret the requests
//     carried is cut out of a reply then, and kept as where it goes back and how it was written.
//   - replayedServices and replayedDatabaseCommands answer a replay's run from a recording, in
//     order, and send nothing. A request whose hash differs, one after the last recorded reply, or a
//     reply never used is a mismatch at its position.
// Stderr and egress events are dropped: the engine reads neither.
import {
  PlanErrorCode, WorkloadOutcomeKind, LEAK_FORMS, failure, isPlainObject, isSecret, success,
  type DatabaseCommandRequest, type DatabaseCommandRunner, type Result, type Secret, type SecretStore, type ServiceCallErrorCode,
  type ServiceCaller, type ServiceRequest, type ServiceResponse, type WorkloadErrorCode, type WorkloadOutcome,
} from '@revisum/contracts';
import { canonicalJson, sha256 } from '../foundation/Sha256.ts';
import { ReplayErrorCode } from '../run/seal/BuildManifest.ts';
import { INVALID, allValid, readInteger, readList, readOneOf, readRecord, type Issues, type Parsed } from '../plan/parse/ReadRecord.ts';
import { readSecretName } from '../project/ParseProject.ts';
import { cutSecretEchoes, restoreSecretEchoes, type SecretEcho } from '../secrets/SecretRedaction.ts';
import { schemaId } from '../foundation/EngineVersion.ts';
import { decodeErrorOf, readSha256, readString, type DecodeError } from './DecodeManifest.ts';

export const RECORDING_SCHEMA = schemaId('run-recording', 1);

// Bytes as a recording keeps them: UTF-8 text as its text, anything else as base64. `secretEchoes`
// lists the secret echoes cut out of the text (of base64 bytes, out of their Latin-1 reading).
export type RecordedBytes =
  | { readonly text: string; readonly secretEchoes?: readonly SecretEcho[] }
  | { readonly base64: string; readonly secretEchoes?: readonly SecretEcho[] };

// One service call's reply: the response, or the code the call failed with.
export type RecordedServiceReply =
  | { readonly requestSha256: string; readonly response: { readonly status: number; readonly mediaType: string | null; readonly body: RecordedBytes } }
  | { readonly requestSha256: string; readonly failure: ServiceCallErrorCode };

// One database command's reply: what the engine reads of its outcome, or why it did not run.
export type RecordedCommandReply =
  | {
    readonly requestSha256: string;
    readonly outcome: { readonly exitCode: number; readonly timedOut: boolean; readonly stdout: RecordedBytes; readonly truncated: boolean };
  }
  | { readonly requestSha256: string; readonly failure: WorkloadErrorCode };

// A run's recorded replies. A port's list is present exactly when the run had that port wired, so
// a replay wires the same ports and no others.
export type RunRecording = {
  readonly schema: string;
  readonly manifestHash: string;
  readonly serviceCalls?: readonly RecordedServiceReply[];
  readonly databaseCommands?: readonly RecordedCommandReply[];
};

export type RecordedReplyKind = 'service-call' | 'database-command';

// The ports a run is given, as recordingPorts wraps them.
export type RepliedPorts = { readonly services?: ServiceCaller; readonly databaseCommands?: DatabaseCommandRunner };
export type RecordingPorts = RepliedPorts & { recording(manifestHash: string): RunRecording };

// ---- Requests, by hash ----------------------------------------------------------------------------

// The request with every Secret replaced by its name and any bytes by their sha256, so its hash
// says which secret it used, never the value, and is the same on every machine.
function byName(value: unknown, secrets: Secret[]): unknown {
  if (isSecret(value)) {
    secrets.push(value);
    return { secretName: value.name };
  }
  if (value instanceof Uint8Array) {return { sha256: sha256(value) };}
  if (Array.isArray(value)) {return value.map((item: unknown) => byName(item, secrets));}
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, byName(item, secrets)]));
  }
  return value;
}

// The request's sha256, and the secrets it carries.
function requestRecord(request: ServiceRequest | DatabaseCommandRequest): { readonly sha256: string; readonly secrets: readonly Secret[] } {
  const secrets: Secret[] = [];
  const shape = byName(request, secrets);
  return { sha256: sha256(canonicalJson(shape)), secrets };
}

// ---- Bytes ----------------------------------------------------------------------------------------

// The bytes as UTF-8 text, or undefined when they are not: invalid UTF-8 never round-trips.
function utf8Text(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function recordedBytes(bytes: Uint8Array, secrets: readonly Secret[]): RecordedBytes {
  const text = utf8Text(bytes);
  // Other bytes are searched in their Latin-1 reading, one character per byte, which finds an
  // ASCII secret wherever it sits.
  const cut = cutSecretEchoes(text ?? Buffer.from(bytes).toString('latin1'), secrets);
  const echoes = cut.echoes.length === 0 ? {} : { secretEchoes: cut.echoes };
  return text === undefined ? { base64: Buffer.from(cut.kept, 'latin1').toString('base64'), ...echoes } : { text: cut.kept, ...echoes };
}

// The bytes a recording kept, with each secret echo put back from the replay's own store.
function replayedBytes(recorded: RecordedBytes, secrets: SecretStore | undefined): Uint8Array {
  const resolve = (name: Secret['name']): Secret | null => secrets?.resolve(name) ?? null;
  const echoes = recorded.secretEchoes ?? [];
  if ('text' in recorded) {return new TextEncoder().encode(restoreSecretEchoes(recorded.text, echoes, resolve));}
  const latin1 = Buffer.from(recorded.base64, 'base64').toString('latin1');
  return new Uint8Array(Buffer.from(restoreSecretEchoes(latin1, echoes, resolve), 'latin1'));
}

// ---- Recording a run ----------------------------------------------------------------------------------

type KeptReply<Reply> = { readonly requestSha256: string; readonly reply: Reply };

// Wraps a run's service caller and command runner so every reply is kept, in order, with its
// request's sha256. Each port is wrapped only when given. The replies stay in memory until
// recording() cuts the secrets out of them: those the requests carried, and `runSecrets`, the
// run's other secrets (such as every secret the project declares, from the run's store), so an
// echo of a secret no request carried is cut too.
export function recordingPorts(ports: RepliedPorts, runSecrets: readonly Secret[] = []): RecordingPorts {
  const secrets: Secret[] = [...runSecrets];
  const calls: KeptReply<Result<ServiceResponse, ServiceCallErrorCode>>[] = [];
  const commands: KeptReply<Result<WorkloadOutcome, WorkloadErrorCode>>[] = [];
  const services = ports.services;
  const databaseCommands = ports.databaseCommands;
  const recordedServices: ServiceCaller | undefined = services === undefined ? undefined : {
    async call(request) {
      const kept = requestRecord(request);
      secrets.push(...kept.secrets);
      const reply = await services.call(request);
      calls.push({ requestSha256: kept.sha256, reply });
      return reply;
    },
  };
  const recordedCommands: DatabaseCommandRunner | undefined = databaseCommands === undefined ? undefined : {
    async run(request) {
      const kept = requestRecord(request);
      secrets.push(...kept.secrets);
      const reply = await databaseCommands.run(request);
      commands.push({ requestSha256: kept.sha256, reply });
      return reply;
    },
  };
  const recording = (manifestHash: string): RunRecording => ({
    schema: RECORDING_SCHEMA,
    manifestHash,
    ...(recordedServices === undefined ? {} : {
      serviceCalls: calls.map(({ requestSha256, reply }): RecordedServiceReply => (reply.ok
        ? { requestSha256, response: { status: reply.value.status, mediaType: reply.value.mediaType, body: recordedBytes(reply.value.body, secrets) } }
        : { requestSha256, failure: reply.error })),
    }),
    ...(recordedCommands === undefined ? {} : {
      databaseCommands: commands.map(({ requestSha256, reply }): RecordedCommandReply => (reply.ok
        ? {
          requestSha256,
          outcome: {
            exitCode: reply.value.kind === WorkloadOutcomeKind.Exited ? reply.value.exitCode : STOPPED_COMMAND_EXIT_CODE, timedOut: reply.value.kind === WorkloadOutcomeKind.TimedOut,
            stdout: recordedBytes(reply.value.stdout.bytes, secrets), truncated: reply.value.stdout.truncated,
          },
        }
        : { requestSha256, failure: reply.error })),
    }),
  });
  return {
    ...(recordedServices === undefined ? {} : { services: recordedServices }),
    ...(recordedCommands === undefined ? {} : { databaseCommands: recordedCommands }),
    recording,
  };
}

// ---- Replaying from a recording ----------------------------------------------------------------------

// A replayed port, and after the run, where its replies first stopped matching: the position of a
// request whose hash differed or that came after the last reply, or, when every request matched,
// the count of replies used if some were never used. Null when every reply was used in order.
export type ReplayedPort<Port> = { readonly port: Port; mismatchAt(): number | null };

// Answers requests from recorded replies, in order. Once one does not match, every later request
// fails too, and the replay ends at the first mismatch.
// A backend or database check repeats its request while the request succeeds and the check has not
// passed. When a recorded reply was changed, such a check can repeat more often than it did in the
// recorded run, so a request that repeats the one just answered gets the same reply again rather
// than counting as a mismatch: the run then goes its own way, and its result hash shows it.
function replayedReplies<Reply, Answer>(
  replies: readonly (Reply & { readonly requestSha256: string })[], answer: (reply: Reply) => Answer, refused: Answer,
): { answerFor(request: ServiceRequest | DatabaseCommandRequest): Answer; mismatchAt(): number | null } {
  let position = 0;
  let mismatch: number | null = null;
  let last: (Reply & { readonly requestSha256: string }) | undefined;
  return {
    answerFor(request) {
      if (mismatch !== null) {return refused;}
      const requestSha256 = requestRecord(request).sha256;
      const reply = replies[position];
      if (reply === undefined || reply.requestSha256 !== requestSha256) {
        if (last !== undefined && last.requestSha256 === requestSha256) {return answer(last);}
        mismatch = position;
        return refused;
      }
      position += 1;
      last = reply;
      return answer(reply);
    },
    mismatchAt: () => mismatch ?? (position < replies.length ? position : null),
  };
}

// The service caller of a replay: it answers from the recorded responses and sends nothing.
export function replayedServices(replies: readonly RecordedServiceReply[], secrets: SecretStore | undefined): ReplayedPort<ServiceCaller> {
  const replayed = replayedReplies(
    replies,
    (reply: RecordedServiceReply): Result<ServiceResponse, ServiceCallErrorCode> => ('failure' in reply
      ? failure(reply.failure)
      : success({ status: reply.response.status, mediaType: reply.response.mediaType, body: replayedBytes(reply.response.body, secrets) })),
    failure('service-unreachable'),
  );
  return { port: { call: async (request) => replayed.answerFor(request) }, mismatchAt: replayed.mismatchAt };
}

// How a recorded command ended, as the outcome a replay gives. A recording keeps only whether it timed
// out, and the run saw the same either way, so its stop is taken as the container going.
const replayedCommandEnd = (outcome: { readonly exitCode: number; readonly timedOut: boolean }) =>
  (outcome.timedOut
    ? ({ kind: 'timed-out', stop: 'removed' } as const)
    : ({ kind: 'exited', exitCode: outcome.exitCode } as const));

// The database-command runner of a replay: it answers from the recorded outputs and runs nothing.
export function replayedDatabaseCommands(
  replies: readonly RecordedCommandReply[], secrets: SecretStore | undefined,
): ReplayedPort<DatabaseCommandRunner> {
  const replayed = replayedReplies(
    replies,
    (reply: RecordedCommandReply): Result<WorkloadOutcome, WorkloadErrorCode> => ('failure' in reply
      ? failure(reply.failure)
      : success({
        ...replayedCommandEnd(reply.outcome), egressEvents: [],
        stdout: { bytes: replayedBytes(reply.outcome.stdout, secrets), truncated: reply.outcome.truncated },
        stderr: { bytes: new Uint8Array(), truncated: false },
      })),
    failure('workload-start-failed'),
  );
  return { port: { run: async (request) => replayed.answerFor(request) }, mismatchAt: replayed.mismatchAt };
}

// ---- Reading a recording back ----------------------------------------------------------------------------

// Every code a call or a command may fail with, so a recorded failure is read as one of them.
const SERVICE_CALL_ERROR_CODES: { readonly [Code in ServiceCallErrorCode]: true } = {
  'response-not-json': true, 'response-too-large': true, 'field-missing': true, 'service-unreachable': true, 'call-timeout': true,
  'unexpected-status': true, 'egress-blocked': true, 'parameter-invalid': true, 'cleanup-failed': true,
};
const WORKLOAD_ERROR_CODES: { readonly [Code in WorkloadErrorCode]: true } = {
  'image-missing': true, 'image-digest-mismatch': true, 'egress-unenforceable': true, 'workload-start-failed': true,
};
const codesOf = <Code extends string>(codes: { readonly [Name in Code]: true }): readonly Code[] =>
  Object.keys(codes).filter((code): code is Code => Object.hasOwn(codes, code));

// The recording format keeps a number here even for a command the runner stopped, which has none.
const STOPPED_COMMAND_EXIT_CODE = -1;

const MAXIMUM_REPLIES = 100_000;
const MAXIMUM_ECHOES = 10_000;
// The longest body or output kept, as base64 or text: the largest any declaration allows, with room.
const MAXIMUM_BYTES_TEXT = 512 * 1024 * 1024;
const SPELLING = /^[.ulEe+]+$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function readEcho(input: unknown, path: string, issues: Issues): Parsed<SecretEcho> {
  const keys = ['offset', 'secretName', 'form', 'scheme', 'characters', 'spelling', 'alignment', 'approximate'];
  const fields = readRecord(input, path, issues, keys, ['offset', 'secretName', 'form']);
  if (fields === INVALID) {return INVALID;}
  const offset = readInteger(fields['offset'], `${path}.offset`, issues, 0, MAXIMUM_BYTES_TEXT);
  const secretName = readSecretName(fields['secretName'], `${path}.secretName`, issues);
  const form = readOneOf(fields['form'], `${path}.form`, issues, LEAK_FORMS);
  const scheme = fields['scheme'] === undefined ? undefined : readOneOf(fields['scheme'], `${path}.scheme`, issues, ['bearer', 'basic'] as const);
  const characters = fields['characters'] === undefined ? undefined : readInteger(fields['characters'], `${path}.characters`, issues, 1, MAXIMUM_BYTES_TEXT);
  const spelling = fields['spelling'] === undefined ? undefined : readString(fields['spelling'], `${path}.spelling`, issues, MAXIMUM_BYTES_TEXT);
  if (spelling !== undefined && spelling !== INVALID && !SPELLING.test(spelling)) {issues.push({ code: PlanErrorCode.UnknownValue, path: `${path}.spelling` });}
  const alignment = fields['alignment'] === undefined ? undefined : readInteger(fields['alignment'], `${path}.alignment`, issues, 0, 2);
  const approximate = fields['approximate'];
  if (approximate !== undefined && approximate !== true) {issues.push({ code: PlanErrorCode.WrongType, path: `${path}.approximate` });}
  if (offset === INVALID || secretName === INVALID || form === INVALID || scheme === INVALID || characters === INVALID
    || spelling === INVALID || alignment === INVALID || (spelling !== undefined && !SPELLING.test(spelling))
    || (approximate !== undefined && approximate !== true)) {return INVALID;}
  return {
    offset, secretName, form,
    ...(scheme === undefined ? {} : { scheme }), ...(characters === undefined ? {} : { characters }),
    ...(spelling === undefined ? {} : { spelling }), ...(alignment === undefined ? {} : { alignment }),
    ...(approximate === true ? { approximate } : {}),
  };
}

function readBytes(input: unknown, path: string, issues: Issues): Parsed<RecordedBytes> {
  const fields = readRecord(input, path, issues, ['text', 'base64', 'secretEchoes'], []);
  if (fields === INVALID) {return INVALID;}
  const hasText = Object.hasOwn(fields, 'text');
  if (hasText === Object.hasOwn(fields, 'base64')) { issues.push({ code: PlanErrorCode.MissingField, path: `${path}.${hasText ? 'base64' : 'text'}` }); return INVALID; }
  const raw = hasText ? readString(fields['text'], `${path}.text`, issues, MAXIMUM_BYTES_TEXT) : readString(fields['base64'], `${path}.base64`, issues, MAXIMUM_BYTES_TEXT);
  if (raw === INVALID) {return INVALID;}
  if (!hasText && !BASE64.test(raw)) { issues.push({ code: PlanErrorCode.WrongType, path: `${path}.base64` }); return INVALID; }
  const length = hasText ? raw.length : Buffer.from(raw, 'base64').length;
  let echoes: readonly SecretEcho[] | undefined;
  if (fields['secretEchoes'] !== undefined) {
    const list = readList(fields['secretEchoes'], `${path}.secretEchoes`, issues, MAXIMUM_ECHOES, 0);
    if (list === INVALID) {return INVALID;}
    const read = list.map((entry, index) => readEcho(entry, `${path}.secretEchoes[${index}]`, issues));
    if (!allValid(read)) {return INVALID;}
    // Each echo goes back at or after the one before it, inside the kept text.
    const misplaced = read.findIndex((echo, index) => echo.offset > length || echo.offset < (read[index - 1]?.offset ?? 0));
    if (misplaced !== -1) { issues.push({ code: PlanErrorCode.UnknownValue, path: `${path}.secretEchoes[${misplaced}].offset` }); return INVALID; }
    echoes = read;
  }
  const secretEchoes = echoes === undefined ? {} : { secretEchoes: echoes };
  return hasText ? { text: raw, ...secretEchoes } : { base64: raw, ...secretEchoes };
}

function readServiceReply(input: unknown, path: string, issues: Issues): Parsed<RecordedServiceReply> {
  const fields = readRecord(input, path, issues, ['requestSha256', 'response', 'failure'], ['requestSha256']);
  if (fields === INVALID) {return INVALID;}
  const requestSha256 = readSha256(fields['requestSha256'], `${path}.requestSha256`, issues);
  if (requestSha256 === INVALID) {return INVALID;}
  if (Object.hasOwn(fields, 'failure')) {
    const code = readOneOf(fields['failure'], `${path}.failure`, issues, codesOf(SERVICE_CALL_ERROR_CODES));
    return code === INVALID ? INVALID : { requestSha256, failure: code };
  }
  const response = readRecord(fields['response'], `${path}.response`, issues, ['status', 'mediaType', 'body']);
  if (response === INVALID) {return INVALID;}
  const status = readInteger(response['status'], `${path}.response.status`, issues, 100, 599);
  const mediaType = response['mediaType'] === null ? null : readString(response['mediaType'], `${path}.response.mediaType`, issues);
  const body = readBytes(response['body'], `${path}.response.body`, issues);
  if (status === INVALID || mediaType === INVALID || body === INVALID) {return INVALID;}
  return { requestSha256, response: { status, mediaType, body } };
}

function readCommandReply(input: unknown, path: string, issues: Issues): Parsed<RecordedCommandReply> {
  const fields = readRecord(input, path, issues, ['requestSha256', 'outcome', 'failure'], ['requestSha256']);
  if (fields === INVALID) {return INVALID;}
  const requestSha256 = readSha256(fields['requestSha256'], `${path}.requestSha256`, issues);
  if (requestSha256 === INVALID) {return INVALID;}
  if (Object.hasOwn(fields, 'failure')) {
    const code = readOneOf(fields['failure'], `${path}.failure`, issues, codesOf(WORKLOAD_ERROR_CODES));
    return code === INVALID ? INVALID : { requestSha256, failure: code };
  }
  const outcome = readRecord(fields['outcome'], `${path}.outcome`, issues, ['exitCode', 'timedOut', 'stdout', 'truncated']);
  if (outcome === INVALID) {return INVALID;}
  const exitCode = readInteger(outcome['exitCode'], `${path}.outcome.exitCode`, issues, -(2 ** 31), 2 ** 32);
  const timedOut = outcome['timedOut'];
  const truncated = outcome['truncated'];
  if (typeof timedOut !== 'boolean') {issues.push({ code: PlanErrorCode.WrongType, path: `${path}.outcome.timedOut` });}
  if (typeof truncated !== 'boolean') {issues.push({ code: PlanErrorCode.WrongType, path: `${path}.outcome.truncated` });}
  const stdout = readBytes(outcome['stdout'], `${path}.outcome.stdout`, issues);
  if (exitCode === INVALID || stdout === INVALID || typeof timedOut !== 'boolean' || typeof truncated !== 'boolean') {return INVALID;}
  return { requestSha256, outcome: { exitCode, timedOut, stdout, truncated } };
}

function readReplies<Reply>(
  input: unknown, path: string, issues: Issues, read: (entry: unknown, path: string, issues: Issues) => Parsed<Reply>,
): Parsed<readonly Reply[]> {
  const list = readList(input, path, issues, MAXIMUM_REPLIES, 0);
  if (list === INVALID) {return INVALID;}
  const replies = list.map((entry, index) => read(entry, `${path}[${index}]`, issues));
  return allValid(replies) ? replies : INVALID;
}

// Reads a recording back, as decodeManifest reads a manifest: another schema version, or a key this
// version does not know, is version-unsupported; a known field of the wrong shape, a mismatch at
// its JSON path.
export function decodeRecording(input: unknown): Result<RunRecording, DecodeError> {
  if (!isPlainObject(input)) {return failure({ code: ReplayErrorCode.VersionUnsupported, path: '$' });}
  if (input['schema'] !== RECORDING_SCHEMA) {return failure({ code: ReplayErrorCode.VersionUnsupported, path: '$.schema' });}
  const issues: Issues = [];
  const fields = readRecord(input, '$', issues, ['schema', 'manifestHash', 'serviceCalls', 'databaseCommands'], ['schema', 'manifestHash']);
  if (fields === INVALID) {return failure(decodeErrorOf(issues));}
  const manifestHash = readSha256(fields['manifestHash'], '$.manifestHash', issues);
  const serviceCalls = fields['serviceCalls'] === undefined ? undefined : readReplies(fields['serviceCalls'], '$.serviceCalls', issues, readServiceReply);
  const databaseCommands = fields['databaseCommands'] === undefined
    ? undefined : readReplies(fields['databaseCommands'], '$.databaseCommands', issues, readCommandReply);
  if (manifestHash === INVALID || serviceCalls === INVALID || databaseCommands === INVALID || issues.length > 0) {return failure(decodeErrorOf(issues));}
  return success({
    schema: RECORDING_SCHEMA, manifestHash,
    ...(serviceCalls === undefined ? {} : { serviceCalls }),
    ...(databaseCommands === undefined ? {} : { databaseCommands }),
  });
}
