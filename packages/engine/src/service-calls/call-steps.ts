// Runs the steps that call declared services, through the run's ServiceCaller port:
//   - a call sends its request once, judges the status against the declaration and remembers the
//     response fields the step names as run values; a write is never retried;
//   - a backend check repeats its read call while the service answers with a pending status, or with
//     a success status and a field that has not passed the check, until the project's backend check
//     timeout runs out, which covers background jobs. A call that fails stops the check at once, with
//     its code, and a call declared a write, which a check may never send, stops it before anything
//     is sent;
//   - cleanup calls and cleanup database commands run in order after the steps, whatever the
//     outcome. One that needs a value never set, because the run stopped first, is skipped; one
//     that fails is recorded and raises a review item, and never changes the verdict.
// Each request sent is logged by step, outcome, code, response sha256 and duration only: never an
// argument, a header or the response itself. A body cut short or holding a secret has no sha256.
import {
  failure, StepCode, stepFailed, success,
  type BackendAssertion, type CallArguments, type CallDeclaration, type CallName, type CallStep, type CleanupStep, type Clock, type CommandName, type DeclaredService, type HttpMethod, type JsonPointer, type ResponseReadErrorCode, type Result,
  type SafeText,
  type ScriptArguments, type SecretStore, type ServiceCallErrorCode, type ServiceCaller, type ServiceName, type ServiceRequest, type ServiceResponse,
  type Step, type ValueName,
} from '@revisum/contracts';
import { runDatabaseStep, type DatabaseCommandContext, type DatabaseStepCode } from '../database-commands/database-command-steps.ts';
import type { Logger } from '../logging.ts';
import { rememberedFieldEntries } from '../plan/plan-values.ts';
import type { Project } from '../project/project-parser.ts';
import type { RememberedValues } from '../RememberedValues.ts';
import { resolveText, type RunValues, type StepErrorCode } from '../run-values.ts';
import { sha256UnlessHoldingASecret } from '../secrets/secret-resolution.ts';
import { buildServiceRequest } from './service-request.ts';
import { checkBackendField, fieldAt, fieldText, isGatewayStatus, isPendingStatus, isSuccessStatus, responseJson } from './service-response.ts';

// How long a backend check waits between two reads of its call.
const BACKEND_POLL_INTERVAL_MILLISECONDS = 250;

// What a run records of a step's call: never an argument, a header value or the body, only its
// status and the body's sha256. `attempts` counts a backend check's reads.
export type ServiceCallRecord = {
  readonly call: CallName;
  readonly service: ServiceName;
  readonly method: HttpMethod;
  readonly status: number | null;
  readonly responseSha256: string | null;
  readonly attempts: number;
};

// Why a call or backend-check step failed: a service call error, a run value with no text or
// unsafe text, a secret the run never resolved, or a check that did not pass.
export type CallStepCode = ServiceCallErrorCode | StepErrorCode | 'secret-missing' | 'assertion-failed' | 'unsupported-step';
type CallStepOutcome = {
  readonly outcome: 'passed' | 'failed';
  readonly code?: CallStepCode;
  readonly serviceCall?: ServiceCallRecord;
};

// The codes of a call that got no answer from the service, not even through a gateway. A check then
// learned nothing about the product, so the run could not test, in whatever step the call stood.
export const NO_ANSWER_CODES: readonly string[] = ['service-unreachable', 'call-timeout'] satisfies readonly ServiceCallErrorCode[];

// A cleanup step's record, naming its call or its database command. A failed one is always
// cleanup-failed; `cause` says what failed.
export type CleanupResult = {
  readonly index: number;
  readonly outcome: 'passed' | 'failed' | 'skipped';
  readonly code?: 'cleanup-failed';
  readonly cause?: CallStepCode | DatabaseStepCode | 'unsupported-step';
} & ({ readonly call: CallName } | { readonly command: CommandName });

// What the run hands these steps. `remembered` is how a call adds to the run's values.
export type CallStepContext = {
  readonly caller: ServiceCaller;
  readonly project: Project;
  readonly values: RunValues;
  readonly remembered: RememberedValues;
  readonly secrets: SecretStore;
  readonly clock: Clock;
  readonly logger: Logger;
  // True when text holds one of the run's secrets, in any form.
  readonly holdsSecret: (text: string) => boolean;
};

type Declared = { readonly declaration: CallDeclaration; readonly service: DeclaredService };

// The declaration and service of the run's own project. A plan parsed under another project may
// name a call this one does not declare; it reaches nowhere declared, so it is egress-blocked.
function declared(call: CallName, project: Project): Declared | undefined {
  const declaration = Object.entries(project.calls).find(([name]) => name === call)?.[1];
  const service = project.services.find((candidate) => candidate.name === declaration?.service);
  return declaration === undefined || service === undefined ? undefined : { declaration, service };
}

const failedWith = (code: CallStepCode, serviceCall?: ServiceCallRecord): CallStepOutcome =>
  ({ ...stepFailed(code), ...(serviceCall === undefined ? {} : { serviceCall }) });

// What a status says of an answer. `code` is what the step fails with on it: at once when failed, and
// at the check timeout when pending, the status meaning "not ready yet" and nothing about its body.
type StatusJudgement =
  | { readonly outcome: 'passed' }
  | { readonly outcome: 'pending'; readonly code: CallStepCode }
  | { readonly outcome: 'failed'; readonly code: CallStepCode };
type JudgeStatus = (declaration: CallDeclaration, response: ServiceResponse) => StatusJudgement;

// A call is sent once, so it has nothing to wait for: only its success statuses count.
const judgeForCall: JudgeStatus = (declaration, response) =>
  isSuccessStatus(declaration, response) ? { outcome: 'passed' } : { outcome: 'failed', code: 'unexpected-status' };

// What a backend check's declaration lists wins. Beyond that, a gateway's status says nothing about
// the product, so it is the code of a call the service did not answer, and the run could not test.
const judgeForBackendCheck: JudgeStatus = (declaration, response) => {
  if (isSuccessStatus(declaration, response)) {
    return { outcome: 'passed' };
  }
  const isGateway = isGatewayStatus(response);
  if (isPendingStatus(declaration, response)) {
    return { outcome: 'pending', code: isGateway ? 'service-unreachable' : 'assertion-failed' };
  }
  return { outcome: 'failed', code: isGateway ? 'service-unreachable' : 'unexpected-status' };
};

// What a run keeps of one answer, even when its status failed the judgement, since that call is the
// one a person most needs the record of.
type KeptAnswer = Pick<ServiceCallRecord, 'status' | 'responseSha256'>;
const NO_ANSWER: KeptAnswer = { status: null, responseSha256: null };

// What one request came to: the judgement, what is kept of the answer, and the response itself when
// the step may read on.
type SentRequest =
  | { readonly outcome: 'passed'; readonly kept: KeptAnswer; readonly received: ServiceResponse }
  | { readonly outcome: 'pending'; readonly code: CallStepCode; readonly kept: KeptAnswer }
  | { readonly outcome: 'failed'; readonly code: CallStepCode; readonly kept: KeptAnswer };

// A status that says the service gave no answer says so however long the gateway's page is, so it
// alone survives a body over the cap. Any other such answer is refused, whatever its status. The
// body was cut short, so it has no hash: a hash of it would not be the response's.
function judgeOverTheCap(response: ServiceResponse, found: Declared, judgeStatus: JudgeStatus): SentRequest {
  const judged = judgeStatus(found.declaration, response);
  return judged.outcome === 'failed' && NO_ANSWER_CODES.includes(judged.code)
    ? { outcome: 'failed', code: judged.code, kept: { status: response.status, responseSha256: null } }
    : { outcome: 'failed', code: 'response-too-large', kept: NO_ANSWER };
}

function judgeAnswer(
  answered: Result<ServiceResponse, ServiceCallErrorCode>, request: ServiceRequest, found: Declared, judgeStatus: JudgeStatus, context: CallStepContext,
): SentRequest {
  if (!answered.ok) {
    return { outcome: 'failed', code: answered.error, kept: NO_ANSWER };
  }
  const response = answered.value;
  if (response.body.length > request.maximumResponseBytes) {
    return judgeOverTheCap(response, found, judgeStatus);
  }
  const kept: KeptAnswer = { status: response.status, responseSha256: sha256UnlessHoldingASecret(response.body, context.holdsSecret) };
  const judged = judgeStatus(found.declaration, response);
  return judged.outcome === 'passed' ? { outcome: 'passed', kept, received: response } : { ...judged, kept };
}

// Sends one request, logs it, and judges its status. A pending answer logs as neither passed nor
// failed: nothing is sent after a failed call, and a pending one is sent again.
async function send(
  request: ServiceRequest, found: Declared, judgeStatus: JudgeStatus, stepIndex: number, stepType: Step['type'], context: CallStepContext,
): Promise<SentRequest> {
  const startedAt = context.clock.now();
  const answered = await context.caller.call(request);
  const sent = judgeAnswer(answered, request, found, judgeStatus, context);
  context.logger.log({
    kind: 'service.call', stepIndex, stepType, outcome: sent.outcome,
    ...(sent.outcome === 'failed' ? { code: sent.code } : {}),
    ...(sent.kept.responseSha256 === null ? {} : { sha256: sent.kept.responseSha256 }),
    durationMilliseconds: context.clock.now() - startedAt,
  });
  return sent;
}

function record(step: { readonly call: CallName }, found: Declared, kept: KeptAnswer, attempts: number): ServiceCallRecord {
  return { call: step.call, service: found.service.name, method: found.declaration.method, ...kept, attempts };
}

// The texts of the response fields a call remembers. Every field is read before any is kept.
function textsToRemember(
  step: CallStep, declaration: CallDeclaration, response: ServiceResponse, maximumResponseBytes: number,
): Result<readonly (readonly [ValueName, string])[], CallStepCode> {
  const remembered = rememberedFieldEntries(step.remember);
  if (remembered.length === 0) return success([]);
  const document = responseJson(response, maximumResponseBytes);
  if (!document.ok) return document;
  const entries: (readonly [ValueName, string])[] = [];
  for (const [name, field] of remembered) {
    const pointer = pointerOf(declaration, field);
    const found = pointer === undefined ? failure('field-missing' as const) : fieldAt(document.value, pointer);
    if (!found.ok) return found;
    const text = fieldText(found.value);
    if (text === undefined) return failure('field-missing');
    entries.push([name, text]);
  }
  return success(entries);
}

// The JSON pointer a declaration gives a field.
const pointerOf = (declaration: CallDeclaration, field: string): JsonPointer | undefined =>
  Object.entries(declaration.fields ?? {}).find(([name]) => name === field)?.[1];

// A call step: one request, never repeated.
export async function runCallStep(step: CallStep, stepIndex: number, context: CallStepContext): Promise<CallStepOutcome> {
  const found = declared(step.call, context.project);
  if (found === undefined) return failedWith('egress-blocked');
  const request = buildServiceRequest(found.declaration, found.service, step.arguments, context.values, context.secrets);
  if (!request.ok) return failedWith(request.error, record(step, found, NO_ANSWER, 0));
  const sent = await send(request.value, found, judgeForCall, stepIndex, step.type, context);
  const serviceCall = record(step, found, sent.kept, 1);
  if (sent.outcome !== 'passed') {
    return failedWith(sent.code, serviceCall);
  }
  const texts = textsToRemember(step, found.declaration, sent.received, request.value.maximumResponseBytes);
  if (!texts.ok) return failedWith(texts.error, serviceCall);
  const kept = context.remembered.keepUnrecorded(texts.value);
  return kept.ok ? { outcome: 'passed', serviceCall } : failedWith(kept.error, serviceCall);
}

// What a backend check made of one answer: it passed, or why it has not passed yet.
type AnswerCheck = Result<null, ResponseReadErrorCode | 'assertion-failed'>;

// A response that is not JSON says nothing about the field, so it passes no check, absent included.
function checkAnswer(
  assertion: BackendAssertion, answer: ServiceResponse, pointer: JsonPointer, expected: SafeText | null, maximumResponseBytes: number,
): AnswerCheck {
  const document = responseJson(answer, maximumResponseBytes);
  if (!document.ok) {
    return document;
  }
  const field = fieldAt(document.value, pointer);
  if (checkBackendField(assertion, field.ok ? { value: field.value } : undefined, expected)) {
    return success(null);
  }
  return failure(!field.ok && assertion.kind !== 'present' && assertion.kind !== 'absent' ? 'field-missing' : 'assertion-failed');
}

// A backend check: its read call repeated while the service answers with a pending status, or with a
// success status and a field that has not passed, until the check timeout runs out. A request that
// cannot be built would fail the same way every time, so it fails at once.
export async function runBackendCheck(step: Extract<Step, { type: 'expectBackend' }>, stepIndex: number, context: CallStepContext): Promise<CallStepOutcome> {
  const found = declared(step.call, context.project);
  if (found === undefined) return failedWith('egress-blocked');
  // The parser refuses this, but a plan parsed under another project gets here. A check polls, and a
  // write is never sent twice, so it is not sent at all.
  if (found.declaration.effect === 'write') {
    return failedWith('unsupported-step', record(step, found, NO_ANSWER, 0));
  }
  const expected = 'value' in step.assert && typeof step.assert.value !== 'number'
    ? resolveText(step.assert.value, context.values, context.project.limits.maximumTextLength) : success(null);
  if (!expected.ok) return failedWith(expected.error);
  const request = buildServiceRequest(found.declaration, found.service, step.arguments, context.values, context.secrets);
  if (!request.ok) return failedWith(request.error, record(step, found, NO_ANSWER, 0));
  const pointer = pointerOf(found.declaration, step.field);
  if (pointer === undefined) return failedWith('field-missing', record(step, found, NO_ANSWER, 0));
  const deadline = context.clock.now() + context.project.limits.backendCheckTimeoutMilliseconds;
  for (let attempts = 1; ; attempts++) {
    const sent = await send(request.value, found, judgeForBackendCheck, stepIndex, step.type, context);
    const serviceCall = record(step, found, sent.kept, attempts);
    // A call that failed is not sent again, so an outage is reported at once, not waited out or
    // hidden by a later answer.
    if (sent.outcome === 'failed') {
      return failedWith(sent.code, serviceCall);
    }
    const checked = sent.outcome === 'pending'
      ? failure(sent.code)
      : checkAnswer(step.assert, sent.received, pointer, expected.value, request.value.maximumResponseBytes);
    if (checked.ok) {
      return { outcome: 'passed', serviceCall };
    }
    if (context.clock.now() >= deadline) {
      return failedWith(checked.error, serviceCall);
    }
    await context.clock.sleep(BACKEND_POLL_INTERVAL_MILLISECONDS);
  }
}

// True when the step names a run value that has no text, because the step that would have
// remembered it never ran.
const needsUnsetValue = (stepArguments: CallArguments | ScriptArguments, values: ReadonlyMap<ValueName, SafeText>): boolean =>
  Object.values(stepArguments).some((argument) => typeof argument === 'object' && 'valueName' in argument && !values.has(argument.valueName));

// The cleanup steps, in order, each recorded. They are numbered after the plan's steps in the log.
// A run that calls services always has a call context, and one that runs database commands a
// command context: run() refused it before any step otherwise. Without one, a cleanup step is
// recorded as failed, raising a review item, since its test data may be left behind.
export async function runCleanup(
  cleanup: readonly CleanupStep[], firstIndex: number, context: CallStepContext | undefined, commands?: DatabaseCommandContext,
): Promise<readonly CleanupResult[]> {
  const results: CleanupResult[] = [];
  for (const [index, step] of cleanup.entries()) {
    if (step.type === 'database') {
      const base = { index, command: step.command } as const;
      if (commands === undefined) { results.push({ ...base, outcome: 'failed', code: 'cleanup-failed', cause: 'unsupported-step' }); continue; }
      if (needsUnsetValue(step.arguments, commands.values)) { results.push({ ...base, outcome: 'skipped' }); continue; }
      let done: Awaited<ReturnType<typeof runDatabaseStep>>;
      try {
        done = await runDatabaseStep(step, firstIndex + index, commands);
      } catch {
        done = stepFailed(StepCode.CommandFailed);
      }
      results.push(done.outcome === 'passed'
        ? { ...base, outcome: 'passed' }
        : { ...base, outcome: 'failed', code: 'cleanup-failed', ...(done.code === undefined ? {} : { cause: done.code }) });
      continue;
    }
    const base = { index, call: step.call } as const;
    if (context === undefined) { results.push({ ...base, outcome: 'failed', code: 'cleanup-failed', cause: 'service-unreachable' }); continue; }
    if (needsUnsetValue(step.arguments, context.values)) { results.push({ ...base, outcome: 'skipped' }); continue; }
    let outcome: CallStepOutcome;
    try {
      outcome = await runCallStep(step, firstIndex + index, context);
    } catch {
      outcome = failedWith('service-unreachable');
    }
    results.push(outcome.outcome === 'passed'
      ? { ...base, outcome: 'passed' }
      : { ...base, outcome: 'failed', code: 'cleanup-failed', ...(outcome.code === undefined ? {} : { cause: outcome.code }) });
  }
  return results;
}
