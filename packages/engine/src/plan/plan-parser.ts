// The plan parser: the only way to obtain a Plan. It rejects unknown fields and steps at any
// depth, origins off the allow-list, targets off the matrix, undeclared secrets and fixtures,
// script-like text, vacuous checks and oversized or too deeply nested input, before any side
// effect. Literal secrets are refused: a fill of literal text into a sensitive field, and
// credential-shaped text anywhere. A plan it accepts is frozen and remembered, so run() can tell it from a look-alike.
// The grammar is the one of the version the plan declares: a plan declaring "1.1" is read with
// everything 1.2 added switched off, so it parses exactly as it always did.
// See docs/specs/SPEC-01-plan-language-and-parser.md and docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import {
  AUDIT_MODES, DIALOG_ACTIONS, literalText, ELEMENT_STATE_KINDS, ELEMENT_TEXT_KINDS, LOCATOR_KINDS, MODIFIERS, PAGE_TEXT_KINDS, POSITION_WORDS,
  REMEMBER_READS, ROLES,
  failure, success,
  type AllowedUrl, type CriterionId, type ElementAssertion, type EmailDomain, type FixtureName, type Locator,
  type Modifier, type MultiLineText, type Origin, type PageAssertion, type PathTemplate, type Plan, type PlanData,
  type PlanMeta, type Position, type Result, type SafeText, type SecretName, type SecretReference, type Step, type TargetId,
  type TestIdAttribute, type TextOrValue, type ValueReference,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import { DEFAULT_TEST_ID_ATTRIBUTES, readId, type Limits, type Project } from '../project/project-parser.ts';
import {
  INVALID, allValid, isOneOf, peekRecord, readInteger, readList, readOneOf, readRecord, readText,
  type Issues, type Parsed, type PlanError,
} from './plan-decoders.ts';
import {
  ASSERTION_STEP_TYPES, CAPTURE_NAME, CRITERION_FIELD, CRITERION_ID, CURRENT_GRAMMAR, FEATURE_ID, FROM_FIELD, LOCATOR_FIELDS,
  MAXIMUM_EXPECTED_COUNT, MAXIMUM_MODIFIERS, MAXIMUM_PATH_SEGMENTS, MAXIMUM_POSITION, MAXIMUM_QUERY_VALUES,
  MAXIMUM_SPEC_REFERENCE_LENGTH, MAXIMUM_TEST_ID_LENGTH, MAXIMUM_TITLE_LENGTH, MAXIMUM_URL_LENGTH, META_FIELDS, PLAN_FIELDS,
  QUERY_KEY, grammarFor, type Grammar,
} from './plan-grammar.ts';
import { readGeneratedValues, readPlanClock, readValueName, type ValueContext } from './plan-values.ts';
import { looksLikeCredential, namesSensitiveField } from './literal-secrets.ts';

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
  readonly testIdAttributes: readonly TestIdAttribute[];
  readonly emailDomains: readonly EmailDomain[];
};

type ParseContext = {
  readonly rules: PlanRules;
  readonly issues: Issues;
  // The grammar of the version the plan declares.
  readonly grammar: Grammar;
  // The run values defined so far, in document order: the plan's values, then each remember
  // step's name once that step has been read. A reference to any other name is undefined.
  readonly defined: Set<string>;
};

const rulesOf = (project: Project): PlanRules => ({
  origins: project.origins, targetIds: project.matrix.map((target) => target.id),
  secretNames: project.secretNames, fixtures: project.fixtures, limits: project.limits,
  testIdAttributes: project.testIdAttributes, emailDomains: project.generatedEmailDomains,
});

const isPlainObject = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

// Text from the plan, refused as literal_secret when it is shaped like a credential.
function readPlanText(input: unknown, path: string, context: ParseContext, maximumLength: number, minimumLength = 1): Parsed<SafeText> {
  const text = readText(input, path, context.issues, maximumLength, minimumLength);
  if (text !== INVALID && looksLikeCredential(text)) { context.issues.push({ code: 'literal_secret', path }); return INVALID; }
  return text;
}

// A reference { "valueName": … } to a run value defined earlier in the plan. An undefined name is
// reported at the reference itself.
function readValueReference(input: unknown, path: string, context: ParseContext): Parsed<ValueReference> {
  const fields = readRecord(input, path, context.issues, ['valueName']);
  if (fields === INVALID) return INVALID;
  const valueName = readValueName(fields['valueName'], `${path}.valueName`, context.issues);
  if (valueName === INVALID) return INVALID;
  if (!context.defined.has(valueName)) { context.issues.push({ code: 'undefined_value', path }); return INVALID; }
  return { valueName };
}

// Text the plan writes for the page: literal text, or, from version 1.2, a value reference.
function readTextOrValue(input: unknown, path: string, context: ParseContext, maximumLength: number, minimumLength = 1): Parsed<TextOrValue> {
  if (context.grammar.runValues && isPlainObject(input)) return readValueReference(input, path, context);
  return readPlanText(input, path, context, maximumLength, minimumLength);
}

function readUrl(input: unknown, path: string, context: ParseContext): Parsed<AllowedUrl> {
  const text = readPlanText(input, path, context, MAXIMUM_URL_LENGTH);
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

// One literal segment of a path template. A separator would add segments or start a query or
// fragment; "." and ".." would climb the path. Both are refused here, before any run.
function readLiteralSegment(input: unknown, path: string, context: ParseContext): Parsed<SafeText> {
  const segment = readPlanText(input, path, context, context.rules.limits.maximumTextLength);
  if (segment === INVALID) return INVALID;
  if (/[/?#]/.test(segment)) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  if (segment === '.' || segment === '..') { context.issues.push({ code: 'invalid_url', path }); return INVALID; }
  return segment;
}

// A path template: segments and query values on the run's base URL. It has no origin field, so
// no value can choose where the browser goes. A malformed query key is reported at the query
// itself, so the key is never echoed.
function readPathTemplate(input: unknown, path: string, context: ParseContext): Parsed<PathTemplate> {
  const fields = readRecord(input, path, context.issues, ['segments', 'query'], ['segments']);
  if (fields === INVALID) return INVALID;
  const rawSegments = readList(fields['segments'], `${path}.segments`, context.issues, MAXIMUM_PATH_SEGMENTS);
  const segments = (rawSegments === INVALID ? [] : rawSegments).map((segment, index): Parsed<TextOrValue> => {
    const at = `${path}.segments[${index}]`;
    return isPlainObject(segment) ? readValueReference(segment, at, context) : readLiteralSegment(segment, at, context);
  });
  if (rawSegments === INVALID) return INVALID;
  if (!Object.hasOwn(fields, 'query')) return allValid(segments) ? { segments } : INVALID;
  const query = peekRecord(fields['query'], `${path}.query`, context.issues);
  if (query === INVALID) return INVALID;
  if (Object.keys(query).length > MAXIMUM_QUERY_VALUES) { context.issues.push({ code: 'too_large', path: `${path}.query` }); return INVALID; }
  const entries = Object.entries(query).map(([key, value]): Parsed<readonly [string, TextOrValue]> => {
    if (!QUERY_KEY.test(key)) { context.issues.push({ code: 'unknown_value', path: `${path}.query` }); return INVALID; }
    const text = readTextOrValue(value, `${path}.query.${key}`, context, context.rules.limits.maximumTextLength, 0);
    return text === INVALID ? INVALID : [key, text];
  });
  if (!allValid(segments) || !allValid(entries)) return INVALID;
  return { segments, query: Object.fromEntries(entries) };
}

// Where a navigate step goes: a URL, or, from version 1.2, a path template.
function readNavigation(input: unknown, path: string, context: ParseContext): Parsed<AllowedUrl | PathTemplate> {
  if (context.grammar.runValues && isPlainObject(input)) return readPathTemplate(input, path, context);
  return readUrl(input, path, context);
}

// first, last, or a 1-based index in document order.
function readPosition(input: unknown, path: string, context: ParseContext): Parsed<Position> {
  if (typeof input === 'string') return readOneOf(input, path, context.issues, POSITION_WORDS);
  return readInteger(input, path, context.issues, 1, MAXIMUM_POSITION);
}

// A name from a list the trusted project declares. The error never repeats the name.
function readDeclared<Name extends string>(input: unknown, path: string, context: ParseContext, declared: readonly Name[]): Parsed<Name> {
  if (typeof input !== 'string') { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  const found = declared.find((name) => name === input);
  if (found === undefined) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return found;
}

function readLocator(input: unknown, path: string, context: ParseContext): Parsed<Locator> {
  const longest = context.rules.limits.maximumTextLength;
  const head = peekRecord(input, path, context.issues);
  if (head === INVALID) return INVALID;
  const by = readOneOf(head['by'], `${path}.by`, context.issues, LOCATOR_KINDS);
  if (by === INVALID) return INVALID;
  const allowed = [...LOCATOR_FIELDS[by], ...context.grammar.optionalLocatorFields[by]];
  if (readRecord(input, path, context.issues, allowed, LOCATOR_FIELDS[by]) === INVALID) return INVALID;
  // Optional fields are left out when absent, so a 1.1 locator stays exactly as it was.
  const position = Object.hasOwn(head, 'position') ? readPosition(head['position'], `${path}.position`, context) : undefined;
  const positioned = position === undefined || position === INVALID ? {} : { position };
  switch (by) {
    case 'role': {
      const parts = [
        readOneOf(head['role'], `${path}.role`, context.issues, ROLES),
        readTextOrValue(head['name'], `${path}.name`, context, longest),
      ] as const;
      return allValid(parts) && position !== INVALID ? { by, role: parts[0], name: parts[1], ...positioned } : INVALID;
    }
    case 'label': {
      const label = readTextOrValue(head['label'], `${path}.label`, context, longest);
      return label === INVALID || position === INVALID ? INVALID : { by, label, ...positioned };
    }
    case 'text': {
      const text = readTextOrValue(head['text'], `${path}.text`, context, longest);
      return text === INVALID || position === INVALID ? INVALID : { by, text, ...positioned };
    }
    case 'testId': {
      const testId = readTextOrValue(head['testId'], `${path}.testId`, context, MAXIMUM_TEST_ID_LENGTH);
      const attribute = Object.hasOwn(head, 'attribute')
        ? readDeclared(head['attribute'], `${path}.attribute`, context, context.rules.testIdAttributes) : undefined;
      if (testId === INVALID || attribute === INVALID || position === INVALID) return INVALID;
      return { by, testId, ...(attribute === undefined ? {} : { attribute }), ...positioned };
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
function readExpectedText(input: unknown, path: string, context: ParseContext): Parsed<TextOrValue> {
  const value = readTextOrValue(input, path, context, context.rules.limits.maximumTextLength, 0);
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

function readPageAssertion(input: unknown, path: string, context: ParseContext): Parsed<PageAssertion> {
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, context.grammar.pageKinds);
  if (kind === INVALID) return INVALID;
  if (readRecord(input, path, context.issues, ['kind', 'value']) === INVALID) return INVALID;
  if (kind === 'url') {
    const url = readUrl(head['value'], `${path}.value`, context);
    return url === INVALID ? INVALID : { kind, value: url };
  }
  if (kind === 'urlPathStartsWith') {
    // A plain text prefix of the path, so it must start where every path starts.
    const prefix = readPlanText(head['value'], `${path}.value`, context, MAXIMUM_URL_LENGTH);
    if (prefix !== INVALID && !prefix.startsWith('/')) { context.issues.push({ code: 'invalid_url', path: `${path}.value` }); return INVALID; }
    return prefix === INVALID ? INVALID : { kind, value: prefix };
  }
  if (!isOneOf(PAGE_TEXT_KINDS, kind)) { context.issues.push({ code: 'unknown_value', path: `${path}.kind` }); return INVALID; }
  // A page may have an empty title, so an empty expected title or path is a real check.
  const value = readPlanText(head['value'], `${path}.value`, context, context.rules.limits.maximumTextLength, 0);
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
  if (looksLikeCredential(value)) { context.issues.push({ code: 'literal_secret', path }); return INVALID; }
  return brand<string, 'CriterionId'>(value);
}

// Lines for a multi-line fill, within the project's limits. Too many lines are reported at the
// first line past the limit; too many characters, counting the line feed between lines, at the
// line that crosses the limit. A value reference counts as no characters here: its text is only
// known at run time.
function readMultiLineText(input: unknown, path: string, context: ParseContext): Parsed<MultiLineText> {
  const fields = readRecord(input, path, context.issues, ['lines']);
  if (fields === INVALID) return INVALID;
  const linesPath = `${path}.lines`;
  const { maximumFillLines, maximumFillCharacters } = context.rules.limits;
  const raw = readList(fields['lines'], linesPath, context.issues, Number.POSITIVE_INFINITY);
  if (raw === INVALID) return INVALID;
  if (raw.length > maximumFillLines) { context.issues.push({ code: 'too_large', path: `${linesPath}[${maximumFillLines}]` }); return INVALID; }
  const lines = raw.map((line, index) => readTextOrValue(line, `${linesPath}[${index}]`, context, maximumFillCharacters, 0));
  if (!allValid(lines)) return INVALID;
  let characters = 0;
  for (const [index, line] of lines.entries()) {
    characters += (index === 0 ? 0 : 1) + (literalText(line)?.length ?? 0);
    if (characters > maximumFillCharacters) { context.issues.push({ code: 'too_long', path: `${linesPath}[${index}]` }); return INVALID; }
  }
  return { lines };
}

// A fill value: literal text, a reference to a secret the project declares, and from version 1.2
// a value reference or lines of text.
function readFillValue(input: unknown, path: string, context: ParseContext): Parsed<TextOrValue | SecretReference | MultiLineText> {
  if (!isPlainObject(input)) return readPlanText(input, path, context, context.rules.limits.maximumTextLength, 0);
  if (context.grammar.runValues && Object.hasOwn(input, 'lines')) return readMultiLineText(input, path, context);
  if (context.grammar.runValues && Object.hasOwn(input, 'valueName')) return readValueReference(input, path, context);
  const fields = readRecord(input, path, context.issues, ['secretName']);
  if (fields === INVALID) return INVALID;
  const secretName = readDeclared(fields['secretName'], `${path}.secretName`, context, context.rules.secretNames);
  return secretName === INVALID ? INVALID : { secretName };
}

// True when a fill value writes literal text, as a password typed into the plan would be.
function holdsLiteralText(value: TextOrValue | SecretReference | MultiLineText): boolean {
  if (typeof value === 'object' && 'lines' in value) return value.lines.some((line) => (literalText(line) ?? '') !== '');
  if (typeof value === 'object' && 'secretName' in value) return false;
  return (literalText(value) ?? '') !== '';
}

function readModifiers(input: unknown, path: string, context: ParseContext): Parsed<readonly Modifier[]> {
  const raw = readList(input, path, context.issues, MAXIMUM_MODIFIERS);
  if (raw === INVALID) return INVALID;
  const modifiers = raw.map((modifier, index) => readOneOf(modifier, `${path}[${index}]`, context.issues, MODIFIERS));
  if (!allValid(modifiers)) return INVALID;
  if (new Set(modifiers).size !== modifiers.length) { context.issues.push({ code: 'duplicate', path }); return INVALID; }
  return modifiers;
}

// A capture name names a file, so it follows the capture-name pattern.
function readCaptureName(input: unknown, path: string, context: ParseContext): Parsed<Step> {
  if (typeof input !== 'string') { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (!CAPTURE_NAME.test(input)) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return { type: 'capture', name: brand<string, 'CaptureName'>(input) };
}

// A remember step defines its name only once it has been read, so its own locator cannot use it,
// and a name already defined is a duplicate.
function readRemember(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<Step> {
  const name = readValueName(head['name'], `${path}.name`, context.issues);
  const from = readRecord(head[FROM_FIELD], `${path}.${FROM_FIELD}`, context.issues, ['element', 'read']);
  const parts = from === INVALID ? [INVALID, INVALID] as const : [
    readLocator(from['element'], `${path}.from.element`, context),
    readOneOf(from['read'], `${path}.from.read`, context.issues, REMEMBER_READS),
  ] as const;
  if (name === INVALID) return INVALID;
  if (context.defined.has(name)) { context.issues.push({ code: 'duplicate', path: `${path}.name` }); return INVALID; }
  context.defined.add(name);
  return allValid(parts) ? { type: 'remember', name, from: { element: parts[0], read: parts[1] } } : INVALID;
}

function readStep(input: unknown, path: string, context: ParseContext): Parsed<Step> {
  const head = peekRecord(input, path, context.issues);
  if (head === INVALID) return INVALID;
  const type = readOneOf(head['type'], `${path}.type`, context.issues, context.grammar.stepTypes, 'unknown_step');
  if (type === INVALID) return INVALID;
  const fields = context.grammar.stepFields[type];
  // The criterion id is checked on its own below, so that a missing one is reported as vacuous.
  const required = fields.required.filter((field) => field !== CRITERION_FIELD);
  if (readRecord(input, path, context.issues, [...fields.required, ...fields.optional], required) === INVALID) return INVALID;
  const locator = (): Parsed<Locator> => readLocator(head['locator'], `${path}.locator`, context);
  const longest = context.rules.limits.maximumTextLength;
  switch (type) {
    case 'navigate': {
      const url = readNavigation(head['url'], `${path}.url`, context);
      return url === INVALID ? INVALID : { type, url };
    }
    case 'click':
    case 'hover': {
      const found = locator();
      return found === INVALID ? INVALID : { type, locator: found };
    }
    case 'fill': {
      const parts = [locator(), readFillValue(head['value'], `${path}.value`, context)] as const;
      if (!allValid(parts)) return INVALID;
      // A password or token typed as literal text would put a secret in the plan. Clearing the
      // field with empty text holds no secret, so it stays allowed.
      if (holdsLiteralText(parts[1]) && namesSensitiveField(parts[0])) {
        context.issues.push({ code: 'literal_secret', path: `${path}.value` });
        return INVALID;
      }
      return { type, locator: parts[0], value: parts[1] };
    }
    case 'select': {
      const parts = [locator(), readTextOrValue(head['option'], `${path}.option`, context, longest)] as const;
      return allValid(parts) ? { type, locator: parts[0], option: parts[1] } : INVALID;
    }
    case 'upload': {
      const parts = [locator(), readDeclared(head['fixture'], `${path}.fixture`, context, context.rules.fixtures)] as const;
      return allValid(parts) ? { type, locator: parts[0], fixture: parts[1] } : INVALID;
    }
    case 'press': {
      const parts = [locator(), readOneOf(head['key'], `${path}.key`, context.issues, context.grammar.keys)] as const;
      if (!Object.hasOwn(head, 'modifiers')) return allValid(parts) ? { type, locator: parts[0], key: parts[1] } : INVALID;
      const modifiers = readModifiers(head['modifiers'], `${path}.modifiers`, context);
      return allValid(parts) && modifiers !== INVALID ? { type, locator: parts[0], key: parts[1], modifiers } : INVALID;
    }
    case 'frame': {
      // The depth was checked before the walk began, so this recursion is bounded.
      const parts = [locator(), readStepList(head['steps'], `${path}.steps`, context)] as const;
      return allValid(parts) ? { type, locator: parts[0], steps: parts[1] } : INVALID;
    }
    case 'dialog': {
      const action = readOneOf(head['action'], `${path}.action`, context.issues, DIALOG_ACTIONS);
      if (!Object.hasOwn(head, 'expectText')) return action === INVALID ? INVALID : { type, action };
      const expectText = readTextOrValue(head['expectText'], `${path}.expectText`, context, longest);
      return action === INVALID || expectText === INVALID ? INVALID : { type, action, expectText };
    }
    case 'expect': {
      const parts = [
        locator(), readElementAssertion(head['assert'], `${path}.assert`, context), readCriterionId(head, path, context),
      ] as const;
      if (!allValid(parts)) return INVALID;
      // A count of matches says nothing once a position has picked one of them.
      if ((parts[1].kind === 'countEquals' || parts[1].kind === 'absent') && parts[0].position !== undefined) {
        context.issues.push({ code: 'position_not_allowed', path: `${path}.locator.position` });
        return INVALID;
      }
      return { type, locator: parts[0], assert: parts[1], criterionId: parts[2] };
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
    case 'remember':
      return readRemember(head, path, context);
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
  const featureId = typeof rawFeatureId === 'string' && FEATURE_ID.test(rawFeatureId) && !looksLikeCredential(rawFeatureId)
    ? brand<string, 'FeatureId'>(rawFeatureId) : INVALID;
  if (featureId === INVALID) {
    const credential = typeof rawFeatureId === 'string' && looksLikeCredential(rawFeatureId);
    context.issues.push({ code: credential ? 'literal_secret' : 'unknown_value', path: `${path}.featureId` });
  }
  const parts = [
    featureId,
    readPlanText(fields['specReference'], `${path}.specReference`, context, MAXIMUM_SPEC_REFERENCE_LENGTH),
    readPlanText(fields['title'], `${path}.title`, context, MAXIMUM_TITLE_LENGTH),
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

// Saved browser storage state, named as { secretName }. Storage state written into the plan itself,
// as JSON text or as an object of cookies, is a literal secret: it is refused at $.storageState as
// a whole, so no part of it is read or echoed.
function readStorageState(input: unknown, context: ParseContext): Parsed<SecretReference> {
  const path = '$.storageState';
  const fields = plainFields(input);
  if (typeof input === 'string' || (fields !== undefined && !Object.hasOwn(fields, 'secretName'))) {
    context.issues.push({ code: 'literal_secret', path });
    return INVALID;
  }
  const reference = readRecord(input, path, context.issues, ['secretName']);
  if (reference === INVALID) return INVALID;
  const secretName = readDeclared(reference['secretName'], `${path}.secretName`, context, context.rules.secretNames);
  return secretName === INVALID ? INVALID : { secretName };
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
  isPlainObject(input) ? Object.fromEntries(Object.entries(input)) : undefined;

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
  // The declared version decides the grammar. A version this engine does not read is refused
  // below; the current grammar reads the rest so every other problem is reported too.
  const declaredGrammar = grammarFor(plainFields(input)?.['version']);
  const grammar = declaredGrammar ?? CURRENT_GRAMMAR;
  const context: ParseContext = { rules, issues: [], grammar, defined: new Set() };
  const fields = readRecord(input, '$', context.issues, [...PLAN_FIELDS, ...grammar.optionalPlanFields], PLAN_FIELDS);
  if (fields === INVALID) return failure(context.issues);
  // A plan for a newer language is refused outright: running it with the unknown parts skipped
  // would turn a skipped check into a silent pass.
  if (declaredGrammar === undefined) context.issues.push({ code: 'version_unsupported', path: '$.version' });
  const meta = readMeta(fields['meta'], '$.meta', context);
  const targets = readTargetIds(fields['targets'], context);
  // The plan's values come before every step, so every step may use them.
  const valueContext: ValueContext = {
    issues: context.issues, emailDomains: rules.emailDomains,
    readText: (text, path, maximumLength) => readPlanText(text, path, context, maximumLength),
  };
  const values = Object.hasOwn(fields, 'values') ? readGeneratedValues(fields['values'], '$.values', valueContext, context.defined) : undefined;
  const clock = Object.hasOwn(fields, 'clock') ? readPlanClock(fields['clock'], '$.clock', context.issues) : undefined;
  const steps = readStepList(fields['steps'], '$.steps', context);
  if (steps !== INVALID) checkWholePlan(steps, context);
  const storageState = Object.hasOwn(fields, 'storageState') ? readStorageState(fields['storageState'], context) : undefined;
  if (context.issues.length > 0 || meta === INVALID || targets === INVALID || steps === INVALID || storageState === INVALID
    || values === INVALID || clock === INVALID) return failure(context.issues);
  // Optional fields are left out when absent, so a plan without them hashes as it always did.
  return success({
    version: grammar.version, meta, targets, steps,
    ...(storageState === undefined ? {} : { storageState }),
    ...(values === undefined ? {} : { values }),
    ...(clock === undefined ? {} : { clock }),
  });
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

// The rules the version 1 migration reads its output under: the language only, with the
// project-independent defaults. Version 1 had no secrets, fixtures, frames or run values.
export const languageOnlyRules = (limits: Limits): PlanRules => ({
  origins: 'any', targetIds: 'any', secretNames: [], fixtures: [], limits, testIdAttributes: DEFAULT_TEST_ID_ATTRIBUTES, emailDomains: [],
});

// The run-time half of the brand: the type system stops a forged Plan at compile time, but a cast
// defeats it. run() calls this first, so an object the parser did not make is refused before any
// side effect.
export function assertBranded(plan: unknown): asserts plan is Plan {
  if (typeof plan !== 'object' || plan === null || !PARSED_PLANS.has(plan)) {
    throw new TypeError('refused a plan that the plan parser did not make');
  }
}
