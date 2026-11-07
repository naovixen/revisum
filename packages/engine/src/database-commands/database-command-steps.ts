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
import {
  failure, StepCode, stepFailed, success, type StepOutcome,
  type CommandName, type Clock, type DatabaseCommandDeclaration, type DatabaseCommandRequest, type DatabaseCommandRunner, type DatabaseStep,
  type DeclaredService, type ExpectDatabaseStep, type FieldName, type ParameterName, type Result, type ScriptArguments,
  type DatabaseCommandRecord, type SecretStore, type ValueName, type WorkloadErrorCode, type WorkloadOutcome, type WorkloadVariable,
} from '@revisum/contracts';
import type { Logger } from '../logging.ts';
import { MAXIMUM_SCRIPT_RESULT_DEPTH, nestingDepth } from '../page-scripts/page-script-result.ts';
import { rememberedFieldEntries } from '../plan/plan-values.ts';
import type { Project } from '../project/project-parser.ts';
import { declaredCommands } from '../project/unsafe-feature-declarations.ts';
import { recordsOfRemembered, type RememberedRecord, type RememberedValues } from '../RememberedValues.ts';
import { resolveText, type RunValues, type StepErrorCode } from '../run-values.ts';
import { sha256UnlessHoldingASecret } from '../secrets/secret-resolution.ts';
import { argumentProblem, argumentText, runValueArgument, type ArgumentValue } from '../service-calls/parameter-values.ts';
import { checkBackendField, fieldAt, fieldText } from '../service-calls/service-response.ts';
import { isJudgedLookDone, pollUntil, type JudgedLook } from '../run/PollUntil.ts';

// A declared command's limits when its declaration sets none: 60 seconds and 1 MiB.
export const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 60_000;
const DEFAULT_MAXIMUM_COMMAND_OUTPUT_BYTES = 1024 * 1024;
// How long a database check waits between two runs of its command.
const COMMAND_CHECK_INTERVAL_MILLISECONDS = 250;
// The argument that, by common convention, ends a program's options: what follows is never one.
const END_OF_OPTIONS = '--';

// The codes a command's run may end with besides a check that did not pass. A workload error says
// the command never started, such as image-missing.
export const COMMAND_ERROR_CODES: readonly StepCode[] = [
  StepCode.CommandFailed, StepCode.CommandTimeout, StepCode.CommandOutputInvalid,
  StepCode.ImageMissing, StepCode.ImageDigestMismatch, StepCode.EgressUnenforceable, StepCode.WorkloadStartFailed,
] satisfies readonly (StepErrorCode | WorkloadErrorCode)[];


// Why a database step failed: a step error (the command's own codes among them), a workload error,
// an argument that does not fit, a field the output lacks, a secret the run never resolved, a
// command the run's project does not declare, or a check that did not pass.
export type DatabaseStepCode = StepErrorCode | WorkloadErrorCode
  | typeof StepCode.ParameterInvalid | typeof StepCode.FieldMissing | typeof StepCode.SecretMissing | typeof StepCode.EgressBlocked
  | typeof StepCode.AssertionFailed;

// What one of these steps gives its step result. A step that remembers one value records it as
// `remembered`; one that remembers several records them all in `rememberedValues`.
type DatabaseStepOutcome =
  | {
    readonly outcome: typeof StepOutcome.Passed;
    readonly databaseCommand?: DatabaseCommandRecord;
    readonly remembered?: RememberedRecord;
    readonly rememberedValues?: readonly RememberedRecord[];
  }
  | { readonly outcome: typeof StepOutcome.Failed; readonly code: DatabaseStepCode; readonly databaseCommand?: DatabaseCommandRecord };

// What the run hands these steps. `remembered` is how a step adds to the run's values. `secrets`
// holds only the secrets the run resolved for commands.
export type DatabaseCommandContext = {
  readonly runner: DatabaseCommandRunner;
  readonly project: Project;
  readonly values: RunValues;
  readonly remembered: RememberedValues;
  readonly secrets: SecretStore;
  readonly clock: Clock;
  readonly logger: Logger;
  // True when text holds one of the run's secrets, in any form.
  readonly holdsSecret: (text: string) => boolean;
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
  ({ ...stepFailed(code), ...(databaseCommand === undefined ? {} : { databaseCommand }) });

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
  const outputSha256 = reply.ok && !reply.value.stdout.truncated ? sha256UnlessHoldingASecret(reply.value.stdout.bytes, context.holdsSecret) : null;
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

// The texts of the output fields a step remembers. Every field is read before any is kept.
function textsToRemember(
  step: DatabaseStep, document: unknown, declaration: DatabaseCommandDeclaration,
): Result<readonly (readonly [ValueName, string])[], DatabaseStepCode> {
  const entries: (readonly [ValueName, string])[] = [];
  for (const [name, field] of rememberedFieldEntries(step.remember)) {
    const found = outputField(document, declaration, field);
    if (!found.ok) return found;
    const text = fieldText(found.value);
    if (text === undefined) return failure('field-missing');
    entries.push([name, text]);
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
  const texts = textsToRemember(step, once.result.value, found.declaration);
  if (!texts.ok) return failedWith(texts.error, databaseCommand);
  const remembered = context.remembered.rememberAll(texts.value, stepIndex);
  if (!remembered.ok) return failedWith(remembered.error, databaseCommand);
  return { outcome: 'passed', databaseCommand, ...recordsOfRemembered(remembered.value) };
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
  const rule = {
    timeoutMilliseconds: context.project.limits.backendCheckTimeoutMilliseconds,
    intervalMilliseconds: COMMAND_CHECK_INTERVAL_MILLISECONDS,
    isDone: isJudgedLookDone,
  };
  const last = await pollUntil(context.clock, rule, async (attempts): Promise<JudgedLook<DatabaseStepOutcome>> => {
    const once = await runOnce(request.value, found.declaration, stepIndex, step.type, context);
    const databaseCommand = record(found, once, attempts);
    // A command that failed, timed out or printed nothing readable would do the same again.
    if (!once.result.ok) return { outcome: failedWith(once.result.error, databaseCommand), isDone: true };
    const field = outputField(once.result.value, found.declaration, step.field);
    if (checkBackendField(step.assert, field.ok ? { value: field.value } : undefined, expected.value)) return { outcome: { outcome: 'passed', databaseCommand }, isDone: true };
    const code = !field.ok && step.assert.kind !== 'present' && step.assert.kind !== 'absent' ? 'field-missing' : 'assertion-failed';
    // The parser lets only a read command stand in a check; a write one is never run twice all the same.
    return { outcome: failedWith(code, databaseCommand), isDone: found.declaration.effect === 'write' };
  });
  return last.outcome;
}
