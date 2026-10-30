// Runs the steps of declared network stubs, request checks and web storage through the session's
// network and storage ports. The engine fills every template here, so a driver only ever receives
// finished bytes and text; it never sees a template, a parameter or a plan.
//   - A stub start answers matching fetch and XHR requests with the declared responses; the run
//     keeps the names of the stubs active, so each check can say it ran against a faked answer.
//   - A request check counts the exchanges an observed request saw, waiting for the project's quiet
//     window before an equals or atMost count, and reads fields of the latest response.
//   - A storage step writes, removes or checks one declared entry. A value read is compared, never
//     kept: a failed check says only that the entry is present, absent or differs.
// Field values, storage values and response bodies never reach the result or the log; a remembered
// field is logged by its name and sha256 only.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import {
  failure, isSecret, success,
  type CallArguments, type Clock, type FieldName, type JsonPointer, type ObservedExchange, type Plan, type RequestName, type ResolvedStub,
  type ResolvedStubResponse, type ResponseAssertion, type Result, type SafeText, type SecretStore, type Session, type Step, type StubDeclaration,
  type StubName, type StubResponseBody, type ValueName,
} from '@revisum/contracts';
import { sha256 } from '../hashing.ts';
import type { Logger } from '../logging.ts';
import { runTimeText } from '../plan/plan-decoders.ts';
import type { Project } from '../project/project-parser.ts';
import { resolveText } from '../run-values.ts';
import { jsonTextWithSecrets, storedTextWithSecrets } from '../secrets/secret-values.ts';
import { bodyOf, filledTemplate, type JsonWithSecrets, type RequestBuildError } from '../service-calls/service-request.ts';
import { fieldAt, fieldText, responseJson } from '../service-calls/service-response.ts';

// How long a check waits between two looks at the exchanges or the storage.
const POLL_INTERVAL_MILLISECONDS = 50;

// What the run hands these steps. `values` and `rememberedTexts` are the run's own: a remember step
// adds to them. `activeStubs` is the run's record of the stubs started and not yet stopped.
export type NetworkStepContext = {
  readonly project: Project;
  // The run's session, whose ports these steps use; null before one is open.
  readonly session: Session | null;
  readonly values: Map<ValueName, SafeText>;
  readonly rememberedTexts: Set<string>;
  // Only the secrets the run resolved for stub starts and storage writes.
  readonly secrets: SecretStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly activeStubs: Set<StubName>;
};

// What one of these steps gives its step result.
export type NetworkStepOutcome = {
  readonly outcome: 'passed' | 'failed';
  readonly code?: string;
  // Only a count, or "present", "absent" or "differs": never a value read from the page or a response.
  readonly observed?: string;
  readonly remembered?: { readonly valueName: ValueName; readonly sha256: string };
};

const passed: NetworkStepOutcome = { outcome: 'passed' };
const failedWith = (code: string, observed?: string): NetworkStepOutcome =>
  ({ outcome: 'failed', code, ...(observed === undefined ? {} : { observed }) });
const UNSUPPORTED = failedWith('unsupported-step');

// The declaration a name gives in the run's own project. The parser checked the name against the
// project the plan was parsed under; a run under another project may not declare it.
const declaredIn = <Declaration>(declarations: Readonly<Record<string, Declaration>>, name: string): Declaration | undefined =>
  Object.entries(declarations).find(([declared]) => declared === name)?.[1];

// ---- Observed requests ----------------------------------------------------------------------

// The requests a plan names, inside frames and second tabs too, in plan order and each once. Only
// these are observed, so a plan that names none leaves the page's service workers alone.
export function observedRequestNames(plan: Plan): readonly RequestName[] {
  const names: RequestName[] = [];
  const visit = (steps: readonly Step[]): void => {
    for (const step of steps) {
      if (step.type === 'frame' || step.type === 'newTab') visit(step.steps);
      const name = step.type === 'resetRequests' || step.type === 'expectRequests' || step.type === 'expectResponse' ? step.request
        : step.type === 'remember' && 'response' in step.from ? step.from.response : undefined;
      if (name !== undefined && !names.includes(name)) names.push(name);
    }
  };
  visit(plan.steps);
  return names;
}

// Starts observing one declared request, or starts it again from nothing.
async function observe(name: RequestName, context: NetworkStepContext): Promise<Result<void, string>> {
  const network = context.session?.network;
  const declaration = declaredIn(context.project.observedRequests, name);
  if (network === undefined || declaration === undefined) return failure('unsupported-step');
  // Without fields no body is ever read, so none is kept.
  const cap = declaration.fields === undefined ? null : declaration.maximumResponseBytes;
  const observed = await network.observe(name, declaration.request, cap);
  return observed.ok ? success(undefined) : failure(observed.error.code);
}

// Before the first step: every request the plan names is observed from the start of the plan, so
// the requests a page sends while it loads are counted too.
export async function startObserving(names: readonly RequestName[], context: NetworkStepContext): Promise<Result<void, string>> {
  for (const name of names) {
    const observed = await observe(name, context);
    if (!observed.ok) return observed;
  }
  return success(undefined);
}

export async function resetRequests(step: Extract<Step, { type: 'resetRequests' }>, context: NetworkStepContext): Promise<NetworkStepOutcome> {
  const observed = await observe(step.request, context);
  return observed.ok ? passed : failedWith(observed.error);
}

// Repeats a look until it passes, says no later look can change the answer, or the project's step
// timeout runs out, and gives the last look.
async function poll<Seen extends { readonly pass: boolean; readonly final?: boolean }>(context: NetworkStepContext, look: () => Promise<Seen>): Promise<Seen> {
  const deadline = context.clock.now() + context.project.limits.stepTimeoutMilliseconds;
  for (;;) {
    const seen = await look();
    if (seen.pass || seen.final === true || context.clock.now() >= deadline) return seen;
    await context.clock.sleep(POLL_INTERVAL_MILLISECONDS);
  }
}

// atLeast passes as soon as enough exchanges were seen. equals and atMost wait first until no
// matching request has been in flight for the quiet window, so a request still to come is counted.
export async function checkRequests(step: Extract<Step, { type: 'expectRequests' }>, context: NetworkStepContext): Promise<NetworkStepOutcome> {
  const network = context.session?.network;
  if (network === undefined) return UNSUPPORTED;
  const count = (): number => network.exchanges(step.request).length;
  const expected = step.count;
  if ('atLeast' in expected) {
    const seen = await poll(context, async () => ({ pass: count() >= expected.atLeast, count: count() }));
    return seen.pass ? passed : failedWith('assertion-failed', `${seen.count} matching requests`);
  }
  const limits = context.project.limits;
  const quiet = await network.quiet(step.request, limits.requestQuietMilliseconds, limits.stepTimeoutMilliseconds);
  if (!quiet.ok) return failedWith(quiet.error.code);
  const seen = count();
  const pass = 'equals' in expected ? seen === expected.equals : seen <= expected.atMost;
  return pass ? passed : failedWith('assertion-failed', `${seen} matching requests`);
}

// The JSON pointer an observed request's declaration gives a field.
const pointerOf = (project: Project, request: RequestName, field: FieldName): JsonPointer | undefined => {
  const declaration = declaredIn(project.observedRequests, request);
  return declaration === undefined ? undefined : declaredIn(declaration.fields ?? {}, field);
};

// One field of an exchange's JSON body: found (with its value), missing, or unreadable.
type FieldRead = Result<{ readonly value: unknown } | undefined, string>;

function readField(exchange: ObservedExchange, pointer: JsonPointer | undefined, maximumResponseBytes: number): FieldRead {
  if (pointer === undefined) return failure('field-missing');
  const document = responseJson({ status: exchange.status ?? 0, mediaType: exchange.mediaType, body: exchange.body ?? new Uint8Array() }, maximumResponseBytes);
  if (!document.ok) return document;
  const found = fieldAt(document.value, pointer);
  return success(found.ok ? { value: found.value } : undefined);
}

// The latest exchange of a request, or request-not-seen when there is none yet.
function latestExchange(context: NetworkStepContext, request: RequestName): Result<ObservedExchange, string> {
  const latest = context.session?.network?.exchanges(request).at(-1);
  return latest === undefined ? failure('request-not-seen') : success(latest);
}

type Look = { readonly pass: boolean; readonly code: string };

// Whether the latest exchange passes the check. Backend data is not rendered text, so a field is
// compared exactly, spaces and case included.
function judgeResponse(assertion: ResponseAssertion, exchange: ObservedExchange, request: RequestName, expected: SafeText | null, context: NetworkStepContext): Look {
  if (assertion.kind === 'statusEquals') return { pass: exchange.status === assertion.value, code: 'assertion-failed' };
  const cap = declaredIn(context.project.observedRequests, request)?.maximumResponseBytes ?? 0;
  const field = readField(exchange, pointerOf(context.project, request, assertion.field), cap);
  if (!field.ok) return { pass: false, code: field.error };
  const found = field.value;
  switch (assertion.kind) {
    case 'fieldPresent': return { pass: found !== undefined, code: 'assertion-failed' };
    case 'fieldAbsent': return { pass: found === undefined, code: 'assertion-failed' };
    case 'fieldEquals': case 'fieldContains': {
      if (found === undefined) return { pass: false, code: 'field-missing' };
      const text = fieldText(found.value);
      const pass = text !== undefined && expected !== null && (assertion.kind === 'fieldEquals' ? text === expected : text.includes(expected));
      return { pass, code: 'assertion-failed' };
    }
  }
}

// Checks the latest exchange, waiting as an element check waits: a later exchange may still come.
export async function checkResponse(step: Extract<Step, { type: 'expectResponse' }>, context: NetworkStepContext): Promise<NetworkStepOutcome> {
  if (context.session?.network === undefined) return UNSUPPORTED;
  const assertion = step.assert;
  let expected: SafeText | null = null;
  if (assertion.kind === 'fieldEquals' || assertion.kind === 'fieldContains') {
    const resolved = resolveText(assertion.value, context.values, context.project.limits.maximumTextLength);
    if (!resolved.ok) return failedWith(resolved.error);
    expected = resolved.value;
  }
  const seen = await poll(context, async (): Promise<Look> => {
    const latest = latestExchange(context, step.request);
    return latest.ok ? judgeResponse(assertion, latest.value, step.request, expected, context) : { pass: false, code: latest.error };
  });
  return seen.pass ? passed : failedWith(seen.code);
}

// A response field as a run value's text: the field's own text, or the decimal length of an array.
function rememberedText(found: { readonly value: unknown } | undefined, read: 'text' | 'arrayLength'): Result<string, string> {
  if (found === undefined) return failure('field-missing');
  if (read === 'arrayLength') return Array.isArray(found.value) ? success(String(found.value.length)) : failure('field-missing');
  const text = fieldText(found.value);
  return text === undefined ? failure('field-missing') : success(text);
}

// A remember step that reads a field of the latest response. The value must pass the same rules as
// plan text; only its name and sha256 are kept.
export async function rememberFromResponse(
  step: Extract<Step, { type: 'remember' }>, index: number, context: NetworkStepContext,
): Promise<NetworkStepOutcome> {
  const from = step.from;
  if (!('response' in from) || context.session?.network === undefined) return UNSUPPORTED;
  const cap = declaredIn(context.project.observedRequests, from.response)?.maximumResponseBytes ?? 0;
  const pointer = pointerOf(context.project, from.response, from.field);
  const seen = await poll(context, async () => {
    const latest = latestExchange(context, from.response);
    const field = latest.ok ? readField(latest.value, pointer, cap) : latest;
    const text = field.ok ? rememberedText(field.value, from.read) : field;
    return { pass: text.ok, text };
  });
  if (!seen.text.ok) return failedWith(seen.text.error);
  const maximumLength = context.project.limits.maximumTextLength;
  if (seen.text.value === '') return failedWith('value-empty');
  if (seen.text.value.length > maximumLength) return failedWith('value-too-long');
  const safe = runTimeText(seen.text.value, maximumLength);
  if (safe === undefined) return failedWith('value-unsafe');
  context.values.set(step.name, safe);
  context.rememberedTexts.add(safe);
  const digest = sha256(safe);
  context.logger.log({ kind: 'value.remembered', stepIndex: index, valueName: step.name, sha256: digest });
  return { outcome: 'passed', remembered: { valueName: step.name, sha256: digest } };
}

// ---- Stubs ----------------------------------------------------------------------------------

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

// One declared response with its body finished: a fixture is left for the driver to read from the
// project's fixtures folder.
function resolveResponse(
  response: StubDeclaration['responses'][number], declaration: StubDeclaration, stubArguments: CallArguments, context: NetworkStepContext,
): Result<ResolvedStubResponse, RequestBuildError> {
  const body: StubResponseBody = response.body;
  let bytes: ResolvedStubResponse['body'];
  if (body === null) bytes = new Uint8Array();
  else if ('fixture' in body) bytes = { fixture: body.fixture };
  else if ('text' in body) bytes = utf8(body.text);
  else {
    const filled = filledTemplate(body.json, declaration.parameters, stubArguments, context.values, context.secrets);
    if (!filled.ok) return filled;
    bytes = utf8(jsonTextWithSecrets(bodyOf(filled.value)));
  }
  return success({ status: response.status, mediaType: response.mediaType, headers: Object.entries(response.headers ?? {}), body: bytes });
}

function resolveStub(name: StubName, declaration: StubDeclaration, stubArguments: CallArguments, context: NetworkStepContext): Result<ResolvedStub, RequestBuildError> {
  const responses: ResolvedStubResponse[] = [];
  for (const response of declaration.responses) {
    const resolved = resolveResponse(response, declaration, stubArguments, context);
    if (!resolved.ok) return resolved;
    responses.push(resolved.value);
  }
  return success({ name, request: declaration.request, responses });
}

export async function runStubStep(step: Extract<Step, { type: 'stub' }>, context: NetworkStepContext): Promise<NetworkStepOutcome> {
  const network = context.session?.network;
  const declaration = declaredIn(context.project.stubs, step.stub);
  if (network === undefined || declaration === undefined) return UNSUPPORTED;
  if (step.action === 'stop') {
    const stopped = await network.stopStub(step.stub);
    if (!stopped.ok) return failedWith(stopped.error.code);
    context.activeStubs.delete(step.stub);
    return passed;
  }
  const resolved = resolveStub(step.stub, declaration, step.arguments ?? {}, context);
  if (!resolved.ok) return failedWith(resolved.error);
  const started = await network.startStub(resolved.value);
  if (!started.ok) return failedWith(started.error.code);
  context.activeStubs.add(step.stub);
  return passed;
}

// ---- Web storage ----------------------------------------------------------------------------

// The text a storage entry's value is written as: a string result as it is, anything else as JSON.
function storedText(filled: JsonWithSecrets): string {
  if (typeof filled === 'string') return filled;
  return isSecret(filled) ? storedTextWithSecrets(filled) : storedTextWithSecrets(bodyOf(filled));
}

export async function writeStorage(step: Extract<Step, { type: 'setStorage' | 'removeStorage' }>, context: NetworkStepContext): Promise<NetworkStepOutcome> {
  const storage = context.session?.storage;
  const declaration = declaredIn(context.project.storageEntries, step.entry);
  // The parser refuses a write to a read entry; a run under another project is refused here too.
  if (storage === undefined || declaration === undefined || declaration.access !== 'readWrite') return UNSUPPORTED;
  if (step.type === 'removeStorage') {
    const removed = await storage.remove(declaration.area, declaration.origin, declaration.key);
    return removed.ok ? passed : failedWith(removed.error.code);
  }
  if (declaration.value === undefined) return UNSUPPORTED;
  const filled = filledTemplate(declaration.value, declaration.parameters ?? {}, step.arguments ?? {}, context.values, context.secrets);
  if (!filled.ok) return failedWith(filled.error);
  const written = await storage.write(declaration.area, declaration.origin, declaration.key, storedText(filled.value));
  return written.ok ? passed : failedWith(written.error.code);
}

// What a failed storage check may say about the entry: never its value.
const storageObservation = (value: string | null): string => (value === null ? 'absent' : 'present');

export async function checkStorage(step: Extract<Step, { type: 'expectStorage' }>, context: NetworkStepContext): Promise<NetworkStepOutcome> {
  const storage = context.session?.storage;
  const declaration = declaredIn(context.project.storageEntries, step.entry);
  if (storage === undefined || declaration === undefined) return UNSUPPORTED;
  const assertion = step.assert;
  let expected: SafeText | null = null;
  if (assertion.kind === 'equals') {
    const resolved = resolveText(assertion.value, context.values, context.project.limits.maximumTextLength);
    if (!resolved.ok) return failedWith(resolved.error);
    expected = resolved.value;
  }
  const seen = await poll(context, async () => {
    const read = await storage.read(declaration.area, declaration.origin, declaration.key);
    // A page on another origin, or one that has died, will not answer a later read either.
    if (!read.ok) return { pass: false, final: true, error: read.error.code, observed: '' };
    const value = read.value;
    const pass = assertion.kind === 'present' ? value !== null : assertion.kind === 'absent' ? value === null : value === expected;
    const observed = assertion.kind === 'equals' && value !== null ? 'differs' : storageObservation(value);
    return { pass, error: null, observed };
  });
  if (seen.pass) return passed;
  return seen.error === null ? failedWith('assertion-failed', seen.observed) : failedWith(seen.error);
}
