// Runs the page-script steps through the session's script port, in the document the step stands
// in (the top page, a frame or a second tab):
//   - evaluate runs its script once and may remember fields of the result as run values. A write
//     script is never repeated, and neither is a read one: a failed evaluate ends the run Errored;
//   - expectScript runs its read script and checks one field of the result, repeating until the
//     check passes or the project's scriptCheckTimeoutMilliseconds runs out. A script that throws,
//     times out or gives a result that cannot be decoded stops the check at once.
// The script's source comes from the run's script sources (the protected branch's files) or from
// the plan, and reaches the driver unchanged; arguments go as JSON values, never into the source.
// The result text is decoded by the engine, under its own limits, and only the declared fields
// are read. Neither the text nor a field's value is kept: the result and the log record the
// text's sha256, and a remembered value's name and sha256.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import {
  failure, success,
  type BackendAssertion, type CallEffect, type Clock, type DocumentSession, type EvaluateStep, type ExpectScriptStep, type FieldName,
  type JsonPointer, type ParameterName, type Result, type SafeText, type ScriptArguments, type ScriptChoice, type ScriptName,
  type ScriptParameterType, type ValueName,
} from '@revisum/contracts';
import { sha256 } from '../hashing.ts';
import type { Logger } from '../logging.ts';
import { runTimeText } from '../plan/plan-decoders.ts';
import { rememberedFieldEntries } from '../plan/plan-values.ts';
import type { Project } from '../project/project-parser.ts';
import { declaredScripts } from '../project/unsafe-feature-declarations.ts';
import { resolveText } from '../run-values.ts';
import { argumentProblem, runValueArgument, type ArgumentValue } from '../service-calls/parameter-values.ts';
import { checkBackendField, fieldAt, fieldText } from '../service-calls/service-response.ts';
import { decodeScriptResult } from './page-script-result.ts';

// A declared script's limits when its declaration sets none: 5 seconds and 256 KiB.
export const DEFAULT_SCRIPT_TIMEOUT_MILLISECONDS = 5000;
export const DEFAULT_MAXIMUM_SCRIPT_RESULT_BYTES = 256 * 1024;
// How long a script check waits between two runs of its script.
const SCRIPT_CHECK_INTERVAL_MILLISECONDS = 100;

// What the run hands these steps. `values` and `rememberedTexts` are the run's own: an evaluate
// adds what it remembers.
export type PageScriptContext = {
  readonly project: Project;
  // The declared script files' bytes, keyed by declared file path.
  readonly scriptSources: Readonly<Record<string, Uint8Array>>;
  readonly values: Map<ValueName, SafeText>;
  readonly rememberedTexts: Set<string>;
  readonly clock: Clock;
  readonly logger: Logger;
};

// What a run keeps of a page-script step: the script's name (null for one written in the plan),
// how many times it ran, and the sha256 of the last result text it accepted (null when none was).
export type PageScriptRecord = { readonly script: ScriptName | null; readonly attempts: number; readonly resultSha256: string | null };

type RememberedRecord = { readonly valueName: ValueName; readonly sha256: string };

// What one of these steps gives its step result. An evaluate that remembers one value records it
// as `remembered`, as a remember step does; one that remembers several records them all in
// `rememberedValues`, in the order the plan names them.
export type PageScriptOutcome = {
  readonly outcome: 'passed' | 'failed';
  readonly code?: string;
  readonly pageScript?: PageScriptRecord;
  readonly remembered?: RememberedRecord;
  readonly rememberedValues?: readonly RememberedRecord[];
};

const failedWith = (code: string, pageScript?: PageScriptRecord): PageScriptOutcome =>
  ({ outcome: 'failed', code, ...(pageScript === undefined ? {} : { pageScript }) });
const UNSUPPORTED = failedWith('unsupported-step');

// A script ready to run: its source text and what its declaration, or the plan, says of it.
type ScriptToRun = {
  readonly name: ScriptName | null;
  readonly source: string;
  readonly parameters: Readonly<Record<ParameterName, ScriptParameterType>>;
  readonly effect: CallEffect;
  readonly fields: Readonly<Record<FieldName, JsonPointer>>;
  readonly timeoutMilliseconds: number;
  readonly maximumResultBytes: number;
};

// The script a step names. A named script the run's project does not declare, or whose source the
// run was not given, cannot run here; run() refuses a plan missing a declared script's source
// before any side effect, so that is only a plan parsed under another project.
function scriptToRun(choice: ScriptChoice, context: PageScriptContext): Result<ScriptToRun, string> {
  if (typeof choice !== 'string') {
    const inline = choice.inline;
    // An inline script declares no parameters, so it is called with one empty object.
    return success({
      name: null, source: inline.source, parameters: {}, effect: inline.effect, fields: inline.fields ?? {},
      timeoutMilliseconds: DEFAULT_SCRIPT_TIMEOUT_MILLISECONDS, maximumResultBytes: DEFAULT_MAXIMUM_SCRIPT_RESULT_BYTES,
    });
  }
  const declared = Object.entries(declaredScripts(context.project.unsafeFeatures)).find(([name]) => name === choice);
  if (declared === undefined) return failure('unsupported-step');
  const declaration = declared[1];
  const bytes = Object.hasOwn(context.scriptSources, declaration.file) ? context.scriptSources[declaration.file] : undefined;
  if (bytes === undefined) return failure('unsupported-step');
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // A file that is not UTF-8 text is no script the page could run.
    return failure('script-failed');
  }
  return success({
    name: choice, source, parameters: declaration.parameters, effect: declaration.effect, fields: declaration.fields ?? {},
    timeoutMilliseconds: declaration.timeoutMilliseconds ?? DEFAULT_SCRIPT_TIMEOUT_MILLISECONDS,
    maximumResultBytes: declaration.maximumResultBytes ?? DEFAULT_MAXIMUM_SCRIPT_RESULT_BYTES,
  });
}

// The step's arguments as JSON values, each checked against its declared parameter. A run value's
// text is only known now, so it is checked as a call's argument is: one that does not fit is
// parameter-invalid. The parser checked the literal ones; they are checked again all the same.
function scriptArguments(given: ScriptArguments, script: ScriptToRun, context: PageScriptContext): Result<Record<string, ArgumentValue>, string> {
  const resolved: Record<string, ArgumentValue> = {};
  for (const [name, argument] of Object.entries(given)) {
    const type = Object.entries(script.parameters).find(([parameter]) => parameter === name)?.[1];
    if (type === undefined) return failure('parameter-invalid');
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
    if (argumentProblem(type, value) !== undefined) return failure('parameter-invalid');
    resolved[name] = value;
  }
  return success(resolved);
}

type OneRun = { readonly result: Result<unknown, string>; readonly resultSha256: string | null };

// Runs the script once through the driver and decodes its result. Each run is logged by step,
// outcome, code, the result text's sha256 and duration only.
async function runOnce(
  session: DocumentSession, script: ScriptToRun, callArguments: Readonly<Record<string, ArgumentValue>>, stepIndex: number,
  stepType: 'evaluate' | 'expectScript', context: PageScriptContext,
): Promise<OneRun> {
  if (session.runScript === undefined) return { result: failure('unsupported-step'), resultSha256: null };
  const startedAt = context.clock.now();
  const ran = await session.runScript({
    source: script.source, arguments: callArguments, timeoutMilliseconds: script.timeoutMilliseconds, maximumResultBytes: script.maximumResultBytes,
  });
  const result: Result<unknown, string> = ran.ok ? decodeScriptResult(ran.value, script.maximumResultBytes) : failure(ran.error.code);
  // Only a result text accepted in full is hashed: an oversized one may have been cut short.
  const resultSha256 = ran.ok && result.ok ? sha256(ran.value) : null;
  context.logger.log({
    kind: 'page.script', stepIndex, stepType, outcome: result.ok ? 'passed' : 'failed',
    ...(result.ok ? {} : { code: result.error }), ...(resultSha256 === null ? {} : { sha256: resultSha256 }),
    durationMilliseconds: context.clock.now() - startedAt,
  });
  return { result, resultSha256 };
}

// A declared result field, by the JSON pointer its declaration gives it.
function resultField(document: unknown, script: ScriptToRun, field: FieldName): Result<unknown, 'field-missing'> {
  const pointer = Object.entries(script.fields).find(([name]) => name === field)?.[1];
  return pointer === undefined ? failure('field-missing') : fieldAt(document, pointer);
}

// The result fields an evaluate remembers, as run values. All or none: a value is set only once
// every field has been read, so a failed read leaves the run's values as they were.
function rememberedEntries(
  step: EvaluateStep, document: unknown, script: ScriptToRun, project: Project,
): Result<readonly (readonly [ValueName, SafeText])[], string> {
  const entries: (readonly [ValueName, SafeText])[] = [];
  for (const [name, field] of rememberedFieldEntries(step.remember)) {
    const found = resultField(document, script, field);
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

export async function runEvaluate(step: EvaluateStep, stepIndex: number, session: DocumentSession, context: PageScriptContext): Promise<PageScriptOutcome> {
  if (session.runScript === undefined) return UNSUPPORTED;
  const script = scriptToRun(step.script, context);
  if (!script.ok) return failedWith(script.error);
  const callArguments = scriptArguments(step.arguments, script.value, context);
  if (!callArguments.ok) return failedWith(callArguments.error);
  const once = await runOnce(session, script.value, callArguments.value, stepIndex, step.type, context);
  const pageScript: PageScriptRecord = { script: script.value.name, attempts: 1, resultSha256: once.resultSha256 };
  if (!once.result.ok) return failedWith(once.result.error, pageScript);
  const remembered = rememberedEntries(step, once.result.value, script.value, context.project);
  if (!remembered.ok) return failedWith(remembered.error, pageScript);
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
  return { outcome: 'passed', pageScript, ...kept };
}

// The text a check compares against, with a value reference resolved; null for a check of no text.
function expectedText(assertion: BackendAssertion, context: PageScriptContext): Result<SafeText | null, string> {
  if (!('value' in assertion) || typeof assertion.value === 'number') return success(null);
  return resolveText(assertion.value, context.values, context.project.limits.maximumTextLength);
}

export async function runScriptCheck(step: ExpectScriptStep, stepIndex: number, session: DocumentSession, context: PageScriptContext): Promise<PageScriptOutcome> {
  if (session.runScript === undefined) return UNSUPPORTED;
  const script = scriptToRun(step.script, context);
  if (!script.ok) return failedWith(script.error);
  const callArguments = scriptArguments(step.arguments, script.value, context);
  if (!callArguments.ok) return failedWith(callArguments.error);
  const expected = expectedText(step.assert, context);
  if (!expected.ok) return failedWith(expected.error);
  const deadline = context.clock.now() + context.project.limits.scriptCheckTimeoutMilliseconds;
  for (let attempts = 1; ; attempts++) {
    const once = await runOnce(session, script.value, callArguments.value, stepIndex, step.type, context);
    const pageScript: PageScriptRecord = { script: script.value.name, attempts, resultSha256: once.resultSha256 };
    // A script that throws, hangs or gives no usable result would do the same again: it stops here.
    if (!once.result.ok) return failedWith(once.result.error, pageScript);
    const field = resultField(once.result.value, script.value, step.field);
    if (checkBackendField(step.assert, field.ok ? { value: field.value } : undefined, expected.value)) return { outcome: 'passed', pageScript };
    const code = !field.ok && step.assert.kind !== 'present' && step.assert.kind !== 'absent' ? 'field-missing' : 'assertion-failed';
    // The parser lets only a read script stand in a check; a write one is never run twice all the same.
    if (script.value.effect === 'write' || context.clock.now() >= deadline) return failedWith(code, pageScript);
    await context.clock.sleep(SCRIPT_CHECK_INTERVAL_MILLISECONDS);
  }
}
