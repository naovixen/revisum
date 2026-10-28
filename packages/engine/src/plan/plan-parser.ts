// The plan parser: the only way to obtain a Plan. It rejects unknown fields and steps at any
// depth, origins off the allow-list, targets off the matrix, undeclared secrets and fixtures,
// script-like text, vacuous checks and oversized or too deeply nested input, before any side
// effect. A plan it accepts is frozen and remembered, so run() can tell it from a look-alike.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import {
  AUDIT_MODES, DIALOG_ACTIONS, ELEMENT_STATE_KINDS, ELEMENT_TEXT_KINDS, KEYS, LOCATOR_KINDS, PAGE_TEXT_KINDS, ROLES,
  failure, success,
  type AllowedUrl, type CriterionId, type ElementAssertion, type FixtureName, type Locator, type Origin, type PageAssertion,
  type Plan, type PlanData, type PlanMeta, type Result, type SafeText, type SecretName, type SecretReference, type Step,
  type TargetId,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import { readId, type Limits, type Project } from '../project/project-parser.ts';
import {
  INVALID, allValid, isOneOf, peekRecord, readInteger, readList, readOneOf, readRecord, readText,
  type Issues, type Parsed, type PlanError,
} from './plan-decoders.ts';
import {
  ASSERTION_STEP_TYPES, CAPTURE_NAME, CRITERION_FIELD, CRITERION_ID, CURRENT_PLAN_VERSION, FEATURE_ID, LOCATOR_FIELDS,
  MAXIMUM_EXPECTED_COUNT, MAXIMUM_SPEC_REFERENCE_LENGTH, MAXIMUM_TEST_ID_LENGTH, MAXIMUM_TITLE_LENGTH, MAXIMUM_URL_LENGTH,
  META_FIELDS, PLAN_FIELDS, STEP_FIELDS, STEP_TYPES,
} from './plan-grammar.ts';

// A base used only to tell whether a URL is relative to the app under test.
const RELATIVE_BASE = new URL('https://relative.invalid');

// What a plan may refer to. planParser takes it from the trusted project. The version 1
// migration has no project, so it checks the language only: any http or https origin, any
// well-formed target id. Its output is PlanData, never a Plan, and still has to pass planParser.
export type PlanRules = {
  readonly origins: readonly Origin[] | 'any';
  readonly targetIds: readonly TargetId[] | 'any';
  readonly secretNames: readonly SecretName[];
  readonly fixtures: readonly FixtureName[];
  readonly limits: Limits;
};

type ParseContext = { readonly rules: PlanRules; readonly issues: Issues };

const rulesOf = (project: Project): PlanRules => ({
  origins: project.origins, targetIds: project.matrix.map((target) => target.id),
  secretNames: project.secretNames, fixtures: project.fixtures, limits: project.limits,
});

function readUrl(input: unknown, path: string, context: ParseContext): Parsed<AllowedUrl> {
  const text = readText(input, path, context.issues, MAXIMUM_URL_LENGTH);
  if (text === INVALID) return INVALID;
  let url: URL;
  try { url = new URL(text, RELATIVE_BASE); } catch { context.issues.push({ code: 'invalid_url', path }); return INVALID; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { context.issues.push({ code: 'scheme_not_allowed', path }); return INVALID; }
  if (url.username !== '' || url.password !== '') { context.issues.push({ code: 'invalid_url', path }); return INVALID; }
  if (url.origin === RELATIVE_BASE.origin) {
    if (!text.startsWith('/')) { context.issues.push({ code: 'invalid_url', path }); return INVALID; }
    return brand<string, 'AllowedUrl'>(url.pathname + url.search + url.hash);
  }
  const { origins } = context.rules;
  if (origins !== 'any' && !origins.some((origin) => origin === url.origin)) {
    context.issues.push({ code: 'origin_not_allowed', path });
    return INVALID;
  }
  return brand<string, 'AllowedUrl'>(url.href);
}

function readLocator(input: unknown, path: string, context: ParseContext): Parsed<Locator> {
  const longest = context.rules.limits.maximumTextLength;
  const head = peekRecord(input, path, context.issues);
  if (head === INVALID) return INVALID;
  const by = readOneOf(head['by'], `${path}.by`, context.issues, LOCATOR_KINDS);
  if (by === INVALID) return INVALID;
  if (readRecord(input, path, context.issues, LOCATOR_FIELDS[by]) === INVALID) return INVALID;
  switch (by) {
    case 'role': {
      const parts = [
        readOneOf(head['role'], `${path}.role`, context.issues, ROLES),
        readText(head['name'], `${path}.name`, context.issues, longest),
      ] as const;
      return allValid(parts) ? { by, role: parts[0], name: parts[1] } : INVALID;
    }
    case 'label': {
      const label = readText(head['label'], `${path}.label`, context.issues, longest);
      return label === INVALID ? INVALID : { by, label };
    }
    case 'text': {
      const text = readText(head['text'], `${path}.text`, context.issues, longest);
      return text === INVALID ? INVALID : { by, text };
    }
    case 'testId': {
      const testId = readText(head['testId'], `${path}.testId`, context.issues, MAXIMUM_TEST_ID_LENGTH);
      return testId === INVALID ? INVALID : { by, testId };
    }
  }
}

// An assertion written as `{}` checks nothing, so it is vacuous rather than merely incomplete.
function readAssertionHead(input: unknown, path: string, context: ParseContext): Parsed<Readonly<Record<string, unknown>>> {
  const head = peekRecord(input, path, context.issues);
  if (head === INVALID) return INVALID;
  if (Object.keys(head).length === 0) { context.issues.push({ code: 'vacuous', path }); return INVALID; }
  return head;
}

// Expected text for a text check. Empty text would match any element, so the check proves nothing.
function readExpectedText(input: unknown, path: string, context: ParseContext): Parsed<SafeText> {
  const value = readText(input, path, context.issues, context.rules.limits.maximumTextLength, 0);
  if (value === '') { context.issues.push({ code: 'vacuous', path }); return INVALID; }
  return value;
}

const ELEMENT_KINDS = [...ELEMENT_STATE_KINDS, ...ELEMENT_TEXT_KINDS, 'countEquals'] as const;

function readElementAssertion(input: unknown, path: string, context: ParseContext): Parsed<ElementAssertion> {
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, ELEMENT_KINDS);
  if (kind === INVALID) return INVALID;
  if (isOneOf(ELEMENT_STATE_KINDS, kind)) return readRecord(input, path, context.issues, ['kind']) === INVALID ? INVALID : { kind };
  if (readRecord(input, path, context.issues, ['kind', 'value']) === INVALID) return INVALID;
  if (kind === 'countEquals') {
    const count = readInteger(head['value'], `${path}.value`, context.issues, 0, MAXIMUM_EXPECTED_COUNT);
    return count === INVALID ? INVALID : { kind, value: count };
  }
  const value = readExpectedText(head['value'], `${path}.value`, context);
  return value === INVALID ? INVALID : { kind, value };
}

const PAGE_KINDS = [...PAGE_TEXT_KINDS, 'url'] as const;

function readPageAssertion(input: unknown, path: string, context: ParseContext): Parsed<PageAssertion> {
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, PAGE_KINDS);
  if (kind === INVALID) return INVALID;
  if (readRecord(input, path, context.issues, ['kind', 'value']) === INVALID) return INVALID;
  if (kind === 'url') {
    const url = readUrl(head['value'], `${path}.value`, context);
    return url === INVALID ? INVALID : { kind, value: url };
  }
  // A page may have an empty title, so an empty expected title or path is a real check.
  const value = readText(head['value'], `${path}.value`, context.issues, context.rules.limits.maximumTextLength, 0);
  return value === INVALID ? INVALID : { kind, value };
}

// Every assertion names the acceptance criterion it checks. Without one, a passing check would
// trace to nothing, so a missing or empty id is vacuous.
function readCriterionId(head: Readonly<Record<string, unknown>>, stepPath: string, context: ParseContext): Parsed<CriterionId> {
  const path = `${stepPath}.${CRITERION_FIELD}`;
  const value = head[CRITERION_FIELD];
  if (!Object.hasOwn(head, CRITERION_FIELD) || value === '') { context.issues.push({ code: 'vacuous', path }); return INVALID; }
  if (typeof value !== 'string') { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (!CRITERION_ID.test(value)) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return brand<string, 'CriterionId'>(value);
}

// A name from a list the trusted project declares. The error never repeats the name.
function readDeclared<Name extends string>(input: unknown, path: string, context: ParseContext, declared: readonly Name[]): Parsed<Name> {
  if (typeof input !== 'string') { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  const found = declared.find((name) => name === input);
  if (found === undefined) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return found;
}

// A fill value: literal text, or a reference to a secret the project declares.
function readFillValue(input: unknown, path: string, context: ParseContext): Parsed<SafeText | SecretReference> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return readText(input, path, context.issues, context.rules.limits.maximumTextLength, 0);
  const fields = readRecord(input, path, context.issues, ['secretName']);
  if (fields === INVALID) return INVALID;
  const secretName = readDeclared(fields['secretName'], `${path}.secretName`, context, context.rules.secretNames);
  return secretName === INVALID ? INVALID : { secretName };
}

function readCaptureName(input: unknown, path: string, context: ParseContext): Parsed<Step> {
  if (typeof input !== 'string' || !CAPTURE_NAME.test(input)) {
    context.issues.push({ code: 'unknown_value', path });
    return INVALID;
  }
  return { type: 'capture', name: brand<string, 'CaptureName'>(input) };
}

function readStep(input: unknown, path: string, context: ParseContext): Parsed<Step> {
  const head = peekRecord(input, path, context.issues);
  if (head === INVALID) return INVALID;
  const type = readOneOf(head['type'], `${path}.type`, context.issues, STEP_TYPES, 'unknown_step');
  if (type === INVALID) return INVALID;
  const fields = STEP_FIELDS[type];
  // The criterion id is checked on its own below, so that a missing one is reported as vacuous.
  const required = fields.required.filter((field) => field !== CRITERION_FIELD);
  if (readRecord(input, path, context.issues, [...fields.required, ...fields.optional], required) === INVALID) return INVALID;
  const locator = (): Parsed<Locator> => readLocator(head['locator'], `${path}.locator`, context);
  const longest = context.rules.limits.maximumTextLength;
  switch (type) {
    case 'navigate': {
      const url = readUrl(head['url'], `${path}.url`, context);
      return url === INVALID ? INVALID : { type, url };
    }
    case 'click':
    case 'hover': {
      const found = locator();
      return found === INVALID ? INVALID : { type, locator: found };
    }
    case 'fill': {
      const parts = [locator(), readFillValue(head['value'], `${path}.value`, context)] as const;
      return allValid(parts) ? { type, locator: parts[0], value: parts[1] } : INVALID;
    }
    case 'select': {
      const parts = [locator(), readText(head['option'], `${path}.option`, context.issues, longest)] as const;
      return allValid(parts) ? { type, locator: parts[0], option: parts[1] } : INVALID;
    }
    case 'upload': {
      const parts = [locator(), readDeclared(head['fixture'], `${path}.fixture`, context, context.rules.fixtures)] as const;
      return allValid(parts) ? { type, locator: parts[0], fixture: parts[1] } : INVALID;
    }
    case 'press': {
      const parts = [locator(), readOneOf(head['key'], `${path}.key`, context.issues, KEYS)] as const;
      return allValid(parts) ? { type, locator: parts[0], key: parts[1] } : INVALID;
    }
    case 'frame': {
      // The depth was checked before the walk began, so this recursion is bounded.
      const parts = [locator(), readStepList(head['steps'], `${path}.steps`, context)] as const;
      return allValid(parts) ? { type, locator: parts[0], steps: parts[1] } : INVALID;
    }
    case 'dialog': {
      const action = readOneOf(head['action'], `${path}.action`, context.issues, DIALOG_ACTIONS);
      if (!Object.hasOwn(head, 'expectText')) return action === INVALID ? INVALID : { type, action };
      const expectText = readText(head['expectText'], `${path}.expectText`, context.issues, longest);
      return action === INVALID || expectText === INVALID ? INVALID : { type, action, expectText };
    }
    case 'expect': {
      const parts = [
        locator(), readElementAssertion(head['assert'], `${path}.assert`, context), readCriterionId(head, path, context),
      ] as const;
      return allValid(parts) ? { type, locator: parts[0], assert: parts[1], criterionId: parts[2] } : INVALID;
    }
    case 'expectPage': {
      const parts = [readPageAssertion(head['assert'], `${path}.assert`, context), readCriterionId(head, path, context)] as const;
      return allValid(parts) ? { type, assert: parts[0], criterionId: parts[1] } : INVALID;
    }
    case 'a11yAudit': {
      const mode = readOneOf(head['mode'], `${path}.mode`, context.issues, AUDIT_MODES);
      return mode === INVALID ? INVALID : { type, mode };
    }
    case 'capture':
      return readCaptureName(head['name'], `${path}.name`, context);
  }
}

// A non-empty list of steps, every one read so that a rejection lists every problem.
function readStepList(input: unknown, path: string, context: ParseContext): Parsed<readonly Step[]> {
  const raw = readList(input, path, context.issues, context.rules.limits.maximumSteps);
  if (raw === INVALID) return INVALID;
  const steps = raw.map((step, index) => readStep(step, `${path}[${index}]`, context));
  return allValid(steps) ? steps : INVALID;
}

function readMeta(input: unknown, path: string, context: ParseContext): Parsed<PlanMeta> {
  const fields = readRecord(input, path, context.issues, META_FIELDS);
  if (fields === INVALID) return INVALID;
  const rawFeatureId = fields['featureId'];
  const featureId = typeof rawFeatureId === 'string' && FEATURE_ID.test(rawFeatureId) ? brand<string, 'FeatureId'>(rawFeatureId) : INVALID;
  if (featureId === INVALID) context.issues.push({ code: 'unknown_value', path: `${path}.featureId` });
  const parts = [
    featureId,
    readText(fields['specReference'], `${path}.specReference`, context.issues, MAXIMUM_SPEC_REFERENCE_LENGTH),
    readText(fields['title'], `${path}.title`, context.issues, MAXIMUM_TITLE_LENGTH),
  ] as const;
  return allValid(parts) ? { featureId: parts[0], specReference: parts[1], title: parts[2] } : INVALID;
}

function readTargetIds(input: unknown, context: ParseContext): Parsed<readonly TargetId[]> {
  const { targetIds } = context.rules;
  const raw = readList(input, '$.targets', context.issues, targetIds === 'any' ? 64 : Math.max(1, targetIds.length));
  if (raw === INVALID) return INVALID;
  const ids = raw.map((value, index) => {
    const path = `$.targets[${index}]`;
    const targetId = readId<'TargetId'>(value, path, context.issues);
    if (targetId === INVALID) return INVALID;
    if (targetIds !== 'any' && !targetIds.some((known) => known === targetId)) {
      context.issues.push({ code: 'target_not_in_matrix', path });
      return INVALID;
    }
    return targetId;
  });
  if (new Set(ids).size !== ids.length) { context.issues.push({ code: 'duplicate', path: '$.targets' }); return INVALID; }
  return allValid(ids) ? ids : INVALID;
}

// Every step, including the steps inside frames, depth first.
function everyStep(steps: readonly Step[]): Step[] {
  return steps.flatMap((step) => (step.type === 'frame' ? [step, ...everyStep(step.steps)] : [step]));
}

// Checks across the whole plan once every step has been read: capture names are unique, and the
// plan checks at least one thing.
function checkWholePlan(steps: readonly Step[], context: ParseContext): void {
  const all = everyStep(steps);
  const captureNames = all.flatMap((step) => (step.type === 'capture' ? [step.name] : []));
  if (new Set(captureNames).size !== captureNames.length) context.issues.push({ code: 'duplicate', path: '$.steps' });
  if (!all.some((step) => ASSERTION_STEP_TYPES.includes(step.type))) context.issues.push({ code: 'vacuous', path: '$.steps' });
}

function sizeInBytes(input: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(input) ?? '').length; } catch { return Number.POSITIVE_INFINITY; }
}

const plainFields = (input: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof input === 'object' && input !== null && !Array.isArray(input) ? Object.fromEntries(Object.entries(input)) : undefined;

// The path of the first frame step nested deeper than `maximumDepth`, or undefined. It looks only
// at frame steps and their step lists, without recursion, so even a plan nested thousands deep is
// measured cheaply and before the parser walks it.
function tooDeepFrame(input: unknown, maximumDepth: number): string | undefined {
  const pending: { readonly steps: unknown; readonly path: string; readonly depth: number }[] = [
    { steps: plainFields(input)?.['steps'], path: '$.steps', depth: 0 },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!Array.isArray(next.steps)) continue;
    for (const [index, step] of next.steps.entries()) {
      const fields = plainFields(step);
      if (fields?.['type'] !== 'frame') continue;
      const path = `${next.path}[${index}]`;
      if (next.depth + 1 > maximumDepth) return path;
      pending.push({ steps: fields['steps'], path: `${path}.steps`, depth: next.depth + 1 });
    }
  }
  return undefined;
}

// Reads a plan under `rules`. Size and frame depth are checked first, so an oversized plan gets
// one error, too_large, and nothing inside it is walked.
export function readPlanData(input: unknown, rules: PlanRules): Result<PlanData, readonly PlanError[]> {
  if (sizeInBytes(input) > rules.limits.maximumPlanBytes) return failure([{ code: 'too_large', path: '$' }]);
  const tooDeep = tooDeepFrame(input, rules.limits.maximumFrameDepth);
  if (tooDeep !== undefined) return failure([{ code: 'too_large', path: tooDeep }]);
  const context: ParseContext = { rules, issues: [] };
  const fields = readRecord(input, '$', context.issues, PLAN_FIELDS);
  if (fields === INVALID) return failure(context.issues);
  // A plan for a newer language is refused outright: running it with the unknown parts skipped
  // would turn a skipped check into a silent pass.
  if (fields['version'] !== CURRENT_PLAN_VERSION) context.issues.push({ code: 'version_unsupported', path: '$.version' });
  const meta = readMeta(fields['meta'], '$.meta', context);
  const targets = readTargetIds(fields['targets'], context);
  const steps = readStepList(fields['steps'], '$.steps', context);
  if (steps !== INVALID) checkWholePlan(steps, context);
  if (context.issues.length > 0 || meta === INVALID || targets === INVALID || steps === INVALID) return failure(context.issues);
  return success({ version: CURRENT_PLAN_VERSION, meta, targets, steps });
}

// Every plan this parser made, so that assertBranded can tell a parsed plan from a copy or a
// cast. A WeakSet holds no plan alive and cannot be listed or added to from outside this module.
const PARSED_PLANS = new WeakSet<object>();

function deepFreeze<Value>(value: Value): Value {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

// Builds the parser for one trusted project.
export function planParser(project: Project): (input: unknown) => Result<Plan, readonly PlanError[]> {
  const rules = rulesOf(project);
  return function parsePlan(input) {
    const read = readPlanData(input, rules);
    if (!read.ok) return read;
    // Frozen, so a parsed plan cannot be changed into something the parser never saw.
    const plan = deepFreeze(brand<PlanData, 'Plan'>(read.value));
    PARSED_PLANS.add(plan);
    return success(plan);
  };
}

// The run-time half of the brand: the type system stops a forged Plan at compile time, but a cast
// defeats it. run() calls this first, so an object the parser did not make is refused before any
// side effect.
export function assertBranded(plan: unknown): asserts plan is Plan {
  if (typeof plan !== 'object' || plan === null || !PARSED_PLANS.has(plan)) {
    throw new TypeError('refused a plan that the plan parser did not make');
  }
}
