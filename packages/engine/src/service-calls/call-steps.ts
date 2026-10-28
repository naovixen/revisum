// Runs the steps that call declared services, through the run's ServiceCaller port:
//   - a call sends its request once, judges the status against the declaration and remembers the
//     response fields the step names as run values; a write is never retried;
//   - a backend check repeats its read call until the field passes the check or the project's
//     backend check timeout runs out, which covers background jobs;
//   - cleanup calls run in order after the steps, whatever the outcome. One that needs a value
//     never set, because the run stopped first, is skipped; one that fails is recorded and raises
//     a review item, and never changes the verdict.
// Each request sent is logged by step, outcome, code, response sha256 and duration only: never an
// argument, a header or the response itself.
// See docs/specs/SPEC-32-declared-service-calls.md.
import {
  failure, success,
  type CallDeclaration, type CallName, type CallStep, type Clock, type DeclaredService, type HttpMethod, type JsonPointer, type Result,
  type SafeText,
  type SecretStore, type ServiceCallErrorCode, type ServiceCaller, type ServiceName, type ServiceRequest, type ServiceResponse, type Step,
  type ValueName,
} from '@revisum/contracts';
import { sha256 } from '../hashing.ts';
import type { Logger } from '../logging.ts';
import { runTimeText } from '../plan/plan-decoders.ts';
import { rememberedFieldEntries } from '../plan/plan-values.ts';
import type { Project } from '../project/project-parser.ts';
import { resolveText, type StepErrorCode } from '../run-values.ts';
import { buildServiceRequest } from './service-request.ts';
import { checkBackendField, fieldAt, fieldText, isSuccessStatus, responseJson } from './service-response.ts';

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
export type CallStepCode = ServiceCallErrorCode | StepErrorCode | 'secret-missing' | 'assertion-failed';
export type CallStepOutcome = {
  readonly outcome: 'passed' | 'failed';
  readonly code?: CallStepCode;
  readonly serviceCall?: ServiceCallRecord;
};

// A cleanup call's record. A failed one is always cleanup-failed; `cause` says what failed.
export type CleanupResult = {
  readonly index: number;
  readonly call: CallName;
  readonly outcome: 'passed' | 'failed' | 'skipped';
  readonly code?: 'cleanup-failed';
  readonly cause?: CallStepCode;
};

// What the run hands these steps. `values` is the run's own map: a call adds what it remembers.
export type CallStepContext = {
  readonly caller: ServiceCaller;
  readonly project: Project;
  readonly values: Map<ValueName, SafeText>;
  readonly secrets: SecretStore;
  readonly clock: Clock;
  readonly logger: Logger;
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
  ({ outcome: 'failed', code, ...(serviceCall === undefined ? {} : { serviceCall }) });

// Sends one request, logs it, and judges its status.
async function send(
  request: ServiceRequest, found: Declared, stepIndex: number, stepType: Step['type'], context: CallStepContext,
): Promise<Result<ServiceResponse, ServiceCallErrorCode>> {
  const startedAt = context.clock.now();
  const answered = await context.caller.call(request);
  // The caller stops reading at the cap; a body over it is refused here as well.
  const response: Result<ServiceResponse, ServiceCallErrorCode> = !answered.ok ? answered
    : answered.value.body.length > request.maximumResponseBytes ? failure('response-too-large')
      : !isSuccessStatus(found.declaration, answered.value) ? failure('unexpected-status') : answered;
  context.logger.log({
    kind: 'service.call', stepIndex, stepType, outcome: response.ok ? 'passed' : 'failed',
    ...(response.ok ? {} : { code: response.error }),
    ...(answered.ok ? { sha256: sha256(answered.value.body) } : {}),
    durationMilliseconds: context.clock.now() - startedAt,
  });
  return response;
}

function record(step: { readonly call: CallName }, found: Declared, answered: Result<ServiceResponse, ServiceCallErrorCode> | null, attempts: number): ServiceCallRecord {
  const response = answered === null ? null : answered.ok ? answered.value : null;
  return {
    call: step.call, service: found.service.name, method: found.declaration.method,
    status: response?.status ?? null, responseSha256: response === null ? null : sha256(response.body), attempts,
  };
}

// The response fields a call remembers, as run values. All or none: a value is set only once every
// field has been read, so a failed call leaves the run's values as they were.
function rememberedValues(
  step: CallStep, declaration: CallDeclaration, response: ServiceResponse, maximumResponseBytes: number, project: Project,
): Result<readonly (readonly [ValueName, SafeText])[], CallStepCode> {
  const remembered = rememberedFieldEntries(step.remember);
  if (remembered.length === 0) return success([]);
  const document = responseJson(response, maximumResponseBytes);
  if (!document.ok) return document;
  const entries: (readonly [ValueName, SafeText])[] = [];
  for (const [name, field] of remembered) {
    const pointer = pointerOf(declaration, field);
    const found = pointer === undefined ? failure('field-missing' as const) : fieldAt(document.value, pointer);
    if (!found.ok) return found;
    const text = fieldText(found.value);
    if (text === undefined) return failure('field-missing');
    // A remembered value is plan text from then on, so it passes the same rules as plan text.
    if (text.length > project.limits.maximumTextLength) return failure('value-too-long');
    const safe = runTimeText(text, project.limits.maximumTextLength);
    if (safe === undefined) return failure('value-unsafe');
    entries.push([name, safe]);
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
  if (!request.ok) return failedWith(request.error, record(step, found, null, 0));
  const answered = await send(request.value, found, stepIndex, step.type, context);
  const serviceCall = record(step, found, answered, 1);
  if (!answered.ok) return failedWith(answered.error, serviceCall);
  const remembered = rememberedValues(step, found.declaration, answered.value, request.value.maximumResponseBytes, context.project);
  if (!remembered.ok) return failedWith(remembered.error, serviceCall);
  for (const [name, text] of remembered.value) context.values.set(name, text);
  return { outcome: 'passed', serviceCall };
}

// A backend check: its read call repeated until the field passes or the check timeout runs out.
// A request that cannot be built, or that egress blocks, would fail the same way every time, so it
// fails at once.
export async function runBackendCheck(step: Extract<Step, { type: 'expectBackend' }>, stepIndex: number, context: CallStepContext): Promise<CallStepOutcome> {
  const found = declared(step.call, context.project);
  if (found === undefined) return failedWith('egress-blocked');
  const expected = 'value' in step.assert && typeof step.assert.value !== 'number'
    ? resolveText(step.assert.value, context.values, context.project.limits.maximumTextLength) : success(null);
  if (!expected.ok) return failedWith(expected.error);
  const request = buildServiceRequest(found.declaration, found.service, step.arguments, context.values, context.secrets);
  if (!request.ok) return failedWith(request.error, record(step, found, null, 0));
  const pointer = pointerOf(found.declaration, step.field);
  if (pointer === undefined) return failedWith('field-missing', record(step, found, null, 0));
  const deadline = context.clock.now() + context.project.limits.backendCheckTimeoutMilliseconds;
  for (let attempts = 1; ; attempts++) {
    const answered = await send(request.value, found, stepIndex, step.type, context);
    const serviceCall = record(step, found, answered, attempts);
    let code: CallStepCode;
    if (!answered.ok) {
      code = answered.error;
      if (code === 'egress-blocked') return failedWith(code, serviceCall);
    } else {
      const document = responseJson(answered.value, request.value.maximumResponseBytes);
      const field = document.ok ? fieldAt(document.value, pointer) : document;
      // A response that is not JSON says nothing about the field, so it passes no check, absent included.
      const passed = document.ok
        && checkBackendField(step.assert, field.ok ? { value: field.value } : undefined, expected.value);
      if (passed) return { outcome: 'passed', serviceCall };
      code = !document.ok ? document.error
        : !field.ok && step.assert.kind !== 'present' && step.assert.kind !== 'absent' ? 'field-missing' : 'assertion-failed';
    }
    if (context.clock.now() >= deadline) return failedWith(code, serviceCall);
    await context.clock.sleep(BACKEND_POLL_INTERVAL_MILLISECONDS);
  }
}

// True when the call names a run value that has no text, because the step that would have
// remembered it never ran.
const needsUnsetValue = (step: CallStep, values: ReadonlyMap<ValueName, SafeText>): boolean =>
  Object.values(step.arguments).some((argument) => typeof argument === 'object' && 'valueName' in argument && !values.has(argument.valueName));

// The cleanup calls, in order, each recorded. They are numbered after the plan's steps in the log.
export async function runCleanup(cleanup: readonly CallStep[], firstIndex: number, context: CallStepContext): Promise<readonly CleanupResult[]> {
  const results: CleanupResult[] = [];
  for (const [index, step] of cleanup.entries()) {
    const base = { index, call: step.call } as const;
    if (needsUnsetValue(step, context.values)) { results.push({ ...base, outcome: 'skipped' }); continue; }
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
