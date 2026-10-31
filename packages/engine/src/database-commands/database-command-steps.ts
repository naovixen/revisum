// Runs the steps that run declared database commands, through the run's DatabaseCommandRunner port,
// which cli wires to runner's workload runner:
//   - a database step runs its command once and may remember fields of its JSON output as run
//     values. Neither a write nor a read command is ever repeated: a failed one ends the run Errored;
//   - an expectDatabase check reruns its read command until the field passes the check or the
//     project's backendCheckTimeoutMilliseconds runs out. A command that fails, times out or prints
//     output that cannot be read stops the check at once, since it would do the same again.
// The engine builds each request from the declaration alone. Each parameter fills exactly one
// argument and no shell runs, so nothing a plan passes is split, joined or read as shell syntax. An
// argument starting with "-" could be read as an option, so it fails with parameter-invalid unless
// the declared vector places a literal "--" before it. The environment holds only the declared
// variables, a secret still opaque, and the egress policy reaches only the command's own service.
// The engine judges the reply itself: the exit code, the timeout, and the output, decoded here by
// hand under the declaration's limits. Neither the output nor a field's value is kept: the result
// and the log record the output's sha256, and a remembered value's name and sha256.
// See docs/specs/SPEC-36-unsafe-plan-features.md ("Database commands" under "Milestone").
import {
  failure, success,
  type CommandName, type Clock, type DatabaseCommandDeclaration, type DatabaseCommandRequest, type DatabaseCommandRunner, type DatabaseStep,
  type DeclaredService, type ExpectDatabaseStep, type FieldName, type ParameterName, type Result, type SafeText, type ScriptArguments,
  type SecretStore, type ServiceName, type ValueName, type WorkloadErrorCode, type WorkloadOutcome, type WorkloadVariable,
} from '@revisum/contracts';
import { sha256 } from '../hashing.ts';
import type { Logger } from '../logging.ts';
import { MAXIMUM_SCRIPT_RESULT_DEPTH, nestingDepth } from '../page-scripts/page-script-result.ts';
import { runTimeText } from '../plan/plan-decoders.ts';
import { rememberedFieldEntries } from '../plan/plan-values.ts';
import type { Project } from '../project/project-parser.ts';
import { declaredCommands } from '../project/unsafe-feature-declarations.ts';
import { resolveText, type StepErrorCode } from '../run-values.ts';
import { argumentProblem, argumentText, runValueArgument, type ArgumentValue } from '../service-calls/parameter-values.ts';
import { checkBackendField, fieldAt, fieldText } from '../service-calls/service-response.ts';

// A declared command's limits when its declaration sets none: 60 seconds and 1 MiB.
export const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 60_000;
export const DEFAULT_MAXIMUM_COMMAND_OUTPUT_BYTES = 1024 * 1024;
// How long a database check waits between two runs of its command.
const COMMAND_CHECK_INTERVAL_MILLISECONDS = 250;
// The argument that, by common convention, ends a program's options: what follows is never one.
const END_OF_OPTIONS = '--';

// The codes a command's run may end with besides a check that did not pass. A workload error says
// the command never started, such as image-missing.
export const COMMAND_ERROR_CODES: readonly string[] = [
  'command-failed', 'command-timeout', 'command-output-invalid',
  'image-missing', 'image-digest-mismatch', 'egress-unenforceable', 'workload-start-failed',
] satisfies readonly (StepErrorCode | WorkloadErrorCode)[];

// What a run keeps of a database step: the command, its service, how many times it ran, and of
// its last run the exit code and the sha256 of what it printed on standard output (null when it
// did not run, or its output was cut short). Never the output or an environment value.
export type DatabaseCommandRecord = {
  readonly command: CommandName;
  readonly service: ServiceName;
  readonly exitCode: number | null;
  readonly outputSha256: string | null;
  readonly attempts: number;
};

// Why a database step failed: a step error (the command's own codes among them), a workload error,
// an argument that does not fit, a field the output lacks, a secret the run never resolved, a
// command the run's project does not declare, or a check that did not pass.
export type DatabaseStepCode = StepErrorCode | WorkloadErrorCode
  | 'parameter-invalid' | 'field-missing' | 'secret-missing' | 'egress-blocked' | 'assertion-failed';

type RememberedRecord = { readonly valueName: ValueName; readonly sha256: string };

// What one of these steps gives its step result. A step that remembers one value records it as
// `remembered`; one that remembers several records them all in `rememberedValues`.
export type DatabaseStepOutcome = {
  readonly outcome: 'passed' | 'failed';
  readonly code?: DatabaseStepCode;
  readonly databaseCommand?: DatabaseCommandRecord;
  readonly remembered?: RememberedRecord;
  readonly rememberedValues?: readonly RememberedRecord[];
};

// What the run hands these steps. `values` and `rememberedTexts` are the run's own: a step adds
// what it remembers. `secrets` holds only the secrets the run resolved for commands.
export type DatabaseCommandContext = {
  readonly runner: DatabaseCommandRunner;
  readonly project: Project;
  readonly values: Map<ValueName, SafeText>;
  readonly rememberedTexts: Set<string>;
  readonly secrets: SecretStore;
  readonly clock: Clock;
  readonly logger: Logger;
};

type Declared = { readonly name: CommandName; readonly declaration: DatabaseCommandDeclaration; readonly service: DeclaredService };

// The declaration and service of the run's own project. A plan parsed under another project may
// name a command this one does not declare; it reaches nowhere declared, so it is egress-blocked.
function declared(command: CommandName, project: Project): Declared | undefined {
  const declaration = Object.entries(declaredCommands(project.unsafeFeatures)).find(([name]) => name === command)?.[1];
  const service = project.services.find((candidate) => candidate.name === declaration?.service);
  return declaration === undefined || service === undefined ? undefined : { name: command, declaration, service };
}

const failedWith = (code: DatabaseStepCode, databaseCommand?: DatabaseCommandRecord): DatabaseStepOutcome =>
  ({ outcome: 'failed', code, ...(databaseCommand === undefined ? {} : { databaseCommand }) });

// One parameter's value, checked against its declared type. A run value's text is only known now,
// so it is read as the parameter's type and checked as a call's argument is; the parser checked
// the literal ones, and they are checked again all the same.
function parameterValue(
  name: ParameterName, given: ScriptArguments, declaration: DatabaseCommandDeclaration, context: DatabaseCommandContext,
): Result<ArgumentValue, DatabaseStepCode> {
  const type = Object.entries(declaration.parameters).find(([parameter]) => parameter === name)?.[1];
  const argument = Object.entries(given).find(([parameter]) => parameter === name)?.[1];
  if (type === undefined || argument === undefined) return failure('parameter-invalid');
  let value: ArgumentValue;
  if (typeof argument === 'object') {
    const text = resolveText(argument, context.values, context.project.limits.maximumTextLength);
    if (!text.ok) return text;
    const fitted = runValueArgument(type, text.value);
    if (fitted === undefined) return failure('parameter-invalid');
    value = fitted;
  } else {
    value = argument;
  }
  return argumentProblem(type, value) === undefined ? success(value) : failure('parameter-invalid');
}

// The argument vector: each literal as declared, each parameter as one whole argument. A value
// starting with "-" fails unless a literal "--" comes before it, so a plan can never pass an
// option the declaration did not write.
function commandArguments(given: ScriptArguments, declaration: DatabaseCommandDeclaration, context: DatabaseCommandContext): Result<string[], DatabaseStepCode> {
  const argv: string[] = [];
  let optionsEnded = false;
  for (const argument of declaration.argv) {
    if ('literal' in argument) {
      argv.push(argument.literal);
      if (argument.literal === END_OF_OPTIONS) optionsEnded = true;
      continue;
    }
    const value = parameterValue(argument.$parameter, given, declaration, context);
    if (!value.ok) return value;
    const text = argumentText(value.value);
    if (text.startsWith('-') && !optionsEnded) return failure('parameter-invalid');
    argv.push(text);
  }
  return success(argv);
}

// The declared environment, in declaration order: literals as written, secrets opaque.
function commandEnvironment(declaration: DatabaseCommandDeclaration, secrets: SecretStore): Result<WorkloadVariable[], DatabaseStepCode> {
  const variables: WorkloadVariable[] = [];
  for (const [name, value] of Object.entries(declaration.environment ?? {})) {
    if ('literal' in value) {
      variables.push({ name, value: value.literal });
      continue;
    }
    const secret = secrets.resolve(value.secretName);
    if (secret === null) return failure('secret-missing');
    variables.push({ name, value: secret });
  }
  return success(variables);
}

// The request, built from the declaration alone: the step adds only its arguments.
function commandRequest(found: Declared, given: ScriptArguments, context: DatabaseCommandContext): Result<DatabaseCommandRequest, DatabaseStepCode> {
  const { declaration } = found;
  const argv = commandArguments(given, declaration, context);
  if (!argv.ok) return argv;
  const environment = commandEnvironment(declaration, context.secrets);
  if (!environment.ok) return environment;
  return success({
    image: declaration.image,
    argv: argv.value,
    environment: environment.value,
    // Only the command's own service, and only over TCP: no web origin, no HTTP service.
    policy: { allowOrigins: [], allowServices: [], allowTcpServices: [found.service.name], denyPrivateRanges: true },
    timeoutMilliseconds: declaration.timeoutMilliseconds ?? DEFAULT_COMMAND_TIMEOUT_MILLISECONDS,
    maximumOutputBytes: declaration.maximumOutputBytes ?? DEFAULT_MAXIMUM_COMMAND_OUTPUT_BYTES,
  });
}

// The output as one JSON value. It is outside data, written by the team's program, so it is decoded
// by hand: valid UTF-8, nested no deeper than a page script's result may be, then parsed.
function outputJson(bytes: Uint8Array): Result<unknown, 'command-output-invalid'> {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return failure('command-output-invalid');
  }
  if (nestingDepth(text, MAXIMUM_SCRIPT_RESULT_DEPTH) > MAXIMUM_SCRIPT_RESULT_DEPTH) return failure('command-output-invalid');
  try {
    return success(JSON.parse(text));
  } catch {
    return failure('command-output-invalid');
  }
}

// What the reply says, judged against the declaration: the decoded output (null for a command whose
// output is none), or why the step fails.
function judgedReply(
  reply: Result<WorkloadOutcome, WorkloadErrorCode>, declaration: DatabaseCommandDeclaration, maximumOutputBytes: number,
): Result<unknown, DatabaseStepCode> {
  if (!reply.ok) return reply;
  const outcome = reply.value;
  if (outcome.timedOut) return failure('command-timeout');
  if (!declaration.successExitCodes.includes(outcome.exitCode)) return failure('command-failed');
  if (outcome.stdout.truncated || outcome.stdout.bytes.length > maximumOutputBytes) return failure('command-output-invalid');
  return declaration.output === 'json' ? outputJson(outcome.stdout.bytes) : success(null);
}

type OneRun = { readonly result: Result<unknown, DatabaseStepCode>; readonly exitCode: number | null; readonly outputSha256: string | null };

// Runs the command once through the port and judges the reply. Each run is logged by step, outcome,
// code, the output's sha256 and duration only.
async function runOnce(
  request: DatabaseCommandRequest, declaration: DatabaseCommandDeclaration, stepIndex: number, stepType: 'database' | 'expectDatabase',
  context: DatabaseCommandContext,
): Promise<OneRun> {
  const startedAt = context.clock.now();
  let reply: Result<WorkloadOutcome, WorkloadErrorCode>;
  try {
    reply = await context.runner.run(request);
  } catch {
    // A port that throws never started the command, as far as the run can tell.
    reply = failure('workload-start-failed');
  }
  const result = judgedReply(reply, declaration, request.maximumOutputBytes);
  // Output cut short is only part of what was printed, so it has no hash to keep.
  const outputSha256 = reply.ok && !reply.value.stdout.truncated ? sha256(reply.value.stdout.bytes) : null;
  context.logger.log({
    kind: 'database.command', stepIndex, stepType, outcome: result.ok ? 'passed' : 'failed',
    ...(result.ok ? {} : { code: result.error }), ...(outputSha256 === null ? {} : { sha256: outputSha256 }),
    durationMilliseconds: context.clock.now() - startedAt,
  });
  return { result, exitCode: reply.ok ? reply.value.exitCode : null, outputSha256 };
}

const record = (found: Declared, once: OneRun | null, attempts: number): DatabaseCommandRecord => ({
  command: found.name, service: found.service.name, exitCode: once?.exitCode ?? null, outputSha256: once?.outputSha256 ?? null, attempts,
});

// A declared output field, by the JSON pointer its declaration gives it.
function outputField(document: unknown, declaration: DatabaseCommandDeclaration, field: FieldName): Result<unknown, 'field-missing'> {
  const pointer = Object.entries(declaration.fields ?? {}).find(([name]) => name === field)?.[1];
  return pointer === undefined ? failure('field-missing') : fieldAt(document, pointer);
}

// The output fields a step remembers, as run values. All or none: a value is set only once every
// field has been read, so a failed read leaves the run's values as they were.
function rememberedEntries(
  step: DatabaseStep, document: unknown, declaration: DatabaseCommandDeclaration, project: Project,
): Result<readonly (readonly [ValueName, SafeText])[], DatabaseStepCode> {
  const entries: (readonly [ValueName, SafeText])[] = [];
  for (const [name, field] of rememberedFieldEntries(step.remember)) {
    const found = outputField(document, declaration, field);
    if (!found.ok) return found;
    const text = fieldText(found.value);
    if (text === undefined) return failure('field-missing');
    // A remembered value is plan text from then on, so it passes the same rules as plan text: a
    // line break is value-unsafe, so it never reaches a later command's argument.
    if (text.length > project.limits.maximumTextLength) return failure('value-too-long');
    const safe = runTimeText(text, project.limits.maximumTextLength);
    if (safe === undefined) return failure('value-unsafe');
    entries.push([name, safe]);
  }
  return success(entries);
}

// A database step: its command runs once, never repeated.
export async function runDatabaseStep(step: DatabaseStep, stepIndex: number, context: DatabaseCommandContext): Promise<DatabaseStepOutcome> {
  const found = declared(step.command, context.project);
  if (found === undefined) return failedWith('egress-blocked');
  const request = commandRequest(found, step.arguments, context);
  if (!request.ok) return failedWith(request.error, record(found, null, 0));
  const once = await runOnce(request.value, found.declaration, stepIndex, step.type, context);
  const databaseCommand = record(found, once, 1);
  if (!once.result.ok) return failedWith(once.result.error, databaseCommand);
  const remembered = rememberedEntries(step, once.result.value, found.declaration, context.project);
  if (!remembered.ok) return failedWith(remembered.error, databaseCommand);
  const records: RememberedRecord[] = [];
  for (const [valueName, text] of remembered.value) {
    context.values.set(valueName, text);
    context.rememberedTexts.add(text);
    const digest = sha256(text);
    context.logger.log({ kind: 'value.remembered', stepIndex, valueName, sha256: digest });
    records.push({ valueName, sha256: digest });
  }
  const [only] = records;
  const kept = records.length === 1 && only !== undefined ? { remembered: only } : records.length > 1 ? { rememberedValues: records } : {};
  return { outcome: 'passed', databaseCommand, ...kept };
}

// A database check: its read command rerun until the field passes or the backend check timeout
// runs out. A request that cannot be built would fail the same way every time, so it fails at once.
export async function runDatabaseCheck(step: ExpectDatabaseStep, stepIndex: number, context: DatabaseCommandContext): Promise<DatabaseStepOutcome> {
  const found = declared(step.command, context.project);
  if (found === undefined) return failedWith('egress-blocked');
  const expected = 'value' in step.assert && typeof step.assert.value !== 'number'
    ? resolveText(step.assert.value, context.values, context.project.limits.maximumTextLength) : success(null);
  if (!expected.ok) return failedWith(expected.error);
  const request = commandRequest(found, step.arguments, context);
  if (!request.ok) return failedWith(request.error, record(found, null, 0));
  const deadline = context.clock.now() + context.project.limits.backendCheckTimeoutMilliseconds;
  for (let attempts = 1; ; attempts++) {
    const once = await runOnce(request.value, found.declaration, stepIndex, step.type, context);
    const databaseCommand = record(found, once, attempts);
    // A command that failed, timed out or printed nothing readable would do the same again.
    if (!once.result.ok) return failedWith(once.result.error, databaseCommand);
    const field = outputField(once.result.value, found.declaration, step.field);
    if (checkBackendField(step.assert, field.ok ? { value: field.value } : undefined, expected.value)) return { outcome: 'passed', databaseCommand };
    const code = !field.ok && step.assert.kind !== 'present' && step.assert.kind !== 'absent' ? 'field-missing' : 'assertion-failed';
    // The parser lets only a read command stand in a check; a write one is never run twice all the same.
    if (found.declaration.effect === 'write' || context.clock.now() >= deadline) return failedWith(code, databaseCommand);
    await context.clock.sleep(COMMAND_CHECK_INTERVAL_MILLISECONDS);
  }
}
