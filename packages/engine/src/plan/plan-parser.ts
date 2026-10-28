// The plan parser: the only way to obtain a Plan. It rejects unknown fields and steps at any
// depth, origins off the allow-list, targets off the matrix, undeclared secrets and fixtures,
// script-like text, vacuous checks and oversized or too deeply nested input, before any side
// effect. Literal secrets are refused: a fill of literal text into a sensitive field, and
// credential-shaped text anywhere. A plan it accepts is frozen and remembered, so run() can tell it from a look-alike.
// The grammar is the one of the version the plan declares: a plan declaring "1.1" is read with
// everything 1.2 added switched off, so it parses exactly as it always did.
// Calls name a declaration of the trusted project, with arguments typed by it; nothing a plan
// writes can name a URL, a method, a header or a body. Stubs, request checks and storage entries
// likewise: a plan names a declaration and gives typed arguments, never a response, a matcher, a
// storage key or a value to store.
// See docs/specs/SPEC-01-plan-language-and-parser.md, docs/specs/SPEC-30-plan-values-positions-and-keys.md,
// docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md, docs/specs/SPEC-32-declared-service-calls.md
// and docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import {
  AUDIT_MODES, BACKEND_ASSERTION_KINDS, DIALOG_ACTIONS, DOWNLOAD_SIZE_KINDS, literalText, ELEMENT_STATE_KINDS, LOCATOR_KINDS, MODIFIERS, PAGE_TEXT_KINDS,
  POSITION_WORDS, REMEMBER_READS, REQUEST_COUNT_KINDS, RESPONSE_ASSERTION_KINDS, RESPONSE_FIELD_PRESENCE_KINDS, RESPONSE_READS, ROLES, SCRIPT_MODES,
  STORAGE_ASSERTION_KINDS, STUB_ACTIONS,
  failure, success,
  type AllowedUrl, type BackendAssertion, type Brand, type CallArgument, type CallArguments, type CallDeclaration, type CallName, type CallStep,
  type CriterionId, type DownloadAssertion, type FieldName, type ParameterName, type ParameterType, type ValueName, type DownloadName, type ElementAssertion, type EmailDomain,
  type FixtureName, type JsonPointer, type Locator,
  type Modifier, type MultiLineText, type NetworkAndStorageStep, type ObservedRequestDeclaration, type Origin, type PageAssertion, type PathTemplate,
  type Plan, type PlanData, type PlanMeta, type Position, type RememberSource, type RequestCount, type RequestName, type ResponseAssertion,
  type Result, type SafeText, type SecretName, type SecretReference, type Step, type StorageAssertion, type StorageEntryDeclaration,
  type StorageEntryName, type StubDeclaration, type StubName, type TargetId, type TestIdAttribute, type TextOrValue, type ValueReference,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import { DEFAULT_TEST_ID_ATTRIBUTES, readId, type Limits, type Project } from '../project/project-parser.ts';
import {
  INVALID, allValid, isOneOf, peekRecord, readInteger, readList, readOneOf, readRecord, readText,
  type Issues, type Parsed, type PlanError,
} from './plan-decoders.ts';
import {
  ASSERTION_STEP_TYPES, CAPTURE_NAME, CLEANUP_STEP_TYPES, CRITERION_FIELD, SERVICE_CALL_STEP_TYPES, CRITERION_ID, CURRENT_GRAMMAR, DOWNLOAD_KINDS, DOWNLOAD_NAME, ELEMENT_KINDS, FEATURE_ID,
  FROM_FIELD, LARGEST_DOWNLOAD_BYTES, LOCATOR_FIELDS, MAXIMUM_EXPECTED_COUNT, MAXIMUM_META_NAME_LENGTH, MAXIMUM_MODIFIERS, MAXIMUM_PATH_SEGMENTS, MAXIMUM_POSITION, MAXIMUM_QUERY_VALUES,
  MAXIMUM_SPEC_REFERENCE_LENGTH, MAXIMUM_TEST_ID_LENGTH, MAXIMUM_TITLE_LENGTH, MAXIMUM_URL_LENGTH, META_FIELDS, PLAN_FIELDS,
  QUERY_KEY, RESPONSE_STATUS, grammarFor, type Grammar,
} from './plan-grammar.ts';
import { readGeneratedValues, readPlanClock, readValueName, type ValueContext } from './plan-values.ts';
import { looksLikeCredential, namesSensitiveField } from './literal-secrets.ts';
import { argumentProblem } from '../service-calls/parameter-values.ts';

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
  // The calls a call step may name.
  readonly calls: Readonly<Record<CallName, CallDeclaration>>;
  // The stubs, observed requests and storage entries the steps of SPEC-33 may name.
  readonly stubs: Readonly<Record<StubName, StubDeclaration>>;
  readonly observedRequests: Readonly<Record<RequestName, ObservedRequestDeclaration>>;
  readonly storageEntries: Readonly<Record<StorageEntryName, StorageEntryDeclaration>>;
};

type ParseContext = {
  readonly rules: PlanRules;
  readonly issues: Issues;
  // The grammar of the version the plan declares.
  readonly grammar: Grammar;
  // The run values defined so far, in document order: the plan's values, then each remember
  // step's name once that step has been read. A reference to any other name is undefined.
  readonly defined: Set<string>;
  // The download names defined so far, in document order, each by its download step. They share
  // one plan-wide namespace with the run values, so a name is defined once across both.
  readonly downloads: Set<string>;
  // True while reading the plan's own list of steps, not the steps inside a frame or a second tab.
  readonly topLevel: boolean;
  // The stubs started so far, in document order, anywhere in the plan: a stub applies to the
  // whole browser context, so a stop anywhere after its start is valid.
  readonly startedStubs: Set<string>;
};

const rulesOf = (project: Project): PlanRules => ({
  origins: project.origins, targetIds: project.matrix.map((target) => target.id),
  secretNames: project.secretNames, fixtures: project.fixtures, limits: project.limits,
  testIdAttributes: project.testIdAttributes, emailDomains: project.generatedEmailDomains, calls: project.calls,
  stubs: project.stubs, observedRequests: project.observedRequests, storageEntries: project.storageEntries,
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

// A URL a check compares and never visits, such as a link's target or a canonical URL: an
// absolute http or https URL of any origin, or a path starting with "/", which the check resolves
// against the page's URL. Kept as written.
function isComparedUrl(text: SafeText, path: string, context: ParseContext): boolean {
  let url: URL;
  try { url = new URL(text, RELATIVE_BASE); } catch { context.issues.push({ code: 'invalid_url', path }); return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { context.issues.push({ code: 'scheme_not_allowed', path }); return false; }
  if (url.origin === RELATIVE_BASE.origin && !text.startsWith('/')) { context.issues.push({ code: 'invalid_url', path }); return false; }
  return true;
}

// A link target for hrefEquals: a compared URL, or a value reference whose text is known only at run time.
function readLinkTarget(input: unknown, path: string, context: ParseContext): Parsed<TextOrValue> {
  const value = readTextOrValue(input, path, context, MAXIMUM_URL_LENGTH);
  if (value === INVALID) return INVALID;
  const literal = literalText(value);
  return literal === undefined || isComparedUrl(literal, path, context) ? value : INVALID;
}

function readElementAssertion(input: unknown, path: string, context: ParseContext): Parsed<ElementAssertion> {
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, ELEMENT_KINDS);
  if (kind === INVALID) return INVALID;
  // A kind the declared version does not have is refused as that version's parser refuses it.
  if (!context.grammar.elementKinds.includes(kind)) { context.issues.push({ code: 'unknown_value', path: `${path}.kind` }); return INVALID; }
  if (isOneOf(ELEMENT_STATE_KINDS, kind)) return readRecord(input, path, context.issues, ['kind']) === INVALID ? INVALID : { kind };
  if (readRecord(input, path, context.issues, ['kind', 'value']) === INVALID) return INVALID;
  if (kind === 'countEquals') {
    const count = readInteger(head['value'], `${path}.value`, context.issues, 0, MAXIMUM_EXPECTED_COUNT);
    return count === INVALID ? INVALID : { kind, value: count };
  }
  if (kind === 'hrefEquals') {
    const target = readLinkTarget(head['value'], `${path}.value`, context);
    return target === INVALID ? INVALID : { kind, value: target };
  }
  const value = readExpectedText(head['value'], `${path}.value`, context);
  return value === INVALID ? INVALID : { kind, value };
}

function readPageAssertion(input: unknown, path: string, context: ParseContext): Parsed<PageAssertion> {
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, context.grammar.pageKinds);
  if (kind === INVALID) return INVALID;
  if (kind === 'metaContent') {
    if (readRecord(input, path, context.issues, ['kind', 'name', 'value']) === INVALID) return INVALID;
    const parts = [
      readPlanText(head['name'], `${path}.name`, context, MAXIMUM_META_NAME_LENGTH),
      readExpectedText(head['value'], `${path}.value`, context),
    ] as const;
    return allValid(parts) ? { kind, name: parts[0], value: parts[1] } : INVALID;
  }
  if (readRecord(input, path, context.issues, ['kind', 'value']) === INVALID) return INVALID;
  if (kind === 'canonicalUrl') {
    const canonical = readPlanText(head['value'], `${path}.value`, context, MAXIMUM_URL_LENGTH);
    return canonical === INVALID || !isComparedUrl(canonical, `${path}.value`, context) ? INVALID : { kind, value: canonical };
  }
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

// True when a run value or a download already has the name: the two share one namespace.
const isNameTaken = (name: string, context: ParseContext): boolean => context.defined.has(name) || context.downloads.has(name);

// Where a remember step reads: a field of the latest response a declared request check saw, when
// the source names a response, or else one element of the page.
function readRememberSource(input: unknown, path: string, context: ParseContext): Parsed<RememberSource> {
  const { issues } = context;
  if (isPlainObject(input) && Object.hasOwn(input, 'response')) {
    const fields = readRecord(input, path, issues, ['response', 'field', 'read']);
    if (fields === INVALID) return INVALID;
    const named = readRequestName(fields['response'], `${path}.response`, context);
    const read = readOneOf(fields['read'], `${path}.read`, issues, RESPONSE_READS);
    // An undeclared request is refused alone: its fields are not read against nothing.
    if (named === INVALID) return INVALID;
    const field = readDeclaredField(fields['field'], `${path}.field`, named[1].fields, context);
    return field === INVALID || read === INVALID ? INVALID : { response: named[0], field, read };
  }
  const fields = readRecord(input, path, issues, ['element', 'read']);
  if (fields === INVALID) return INVALID;
  const parts = [
    readLocator(fields['element'], `${path}.element`, context), readOneOf(fields['read'], `${path}.read`, issues, REMEMBER_READS),
  ] as const;
  return allValid(parts) ? { element: parts[0], read: parts[1] } : INVALID;
}

// A remember step defines its name only once it has been read, so its own locator cannot use it,
// and a name already defined is a duplicate.
function readRemember(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<Step> {
  const name = readValueName(head['name'], `${path}.name`, context.issues);
  const from = readRememberSource(head[FROM_FIELD], `${path}.${FROM_FIELD}`, context);
  if (name === INVALID) return INVALID;
  if (isNameTaken(name, context)) { context.issues.push({ code: 'duplicate', path: `${path}.name` }); return INVALID; }
  context.defined.add(name);
  return from === INVALID ? INVALID : { type: 'remember', name, from };
}

// A download's name as plain text, never a value reference: it names the file for the plan, not
// for the page. The error never repeats the name.
function readDownloadName(input: unknown, path: string, context: ParseContext): Parsed<DownloadName> {
  if (typeof input !== 'string') { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (!DOWNLOAD_NAME.test(input)) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return brand<string, 'DownloadName'>(input);
}

// A download step defines its name once its locator has been read; a name a run value or another
// download already has is a duplicate. The name stays defined for every step after it, also
// after the frame or second tab it was defined in.
function readDownload(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<Step> {
  const locator = readLocator(head['locator'], `${path}.locator`, context);
  const name = readDownloadName(head['name'], `${path}.name`, context);
  if (name === INVALID) return INVALID;
  if (isNameTaken(name, context)) { context.issues.push({ code: 'duplicate', path: `${path}.name` }); return INVALID; }
  context.downloads.add(name);
  return locator === INVALID ? INVALID : { type: 'download', name, locator };
}

// The download an expectDownload checks: one an earlier download step defined.
function readDownloadReference(input: unknown, path: string, context: ParseContext): Parsed<DownloadName> {
  const name = readDownloadName(input, path, context);
  if (name === INVALID) return INVALID;
  if (!context.downloads.has(name)) { context.issues.push({ code: 'undefined_value', path }); return INVALID; }
  return name;
}

function readDownloadAssertion(input: unknown, path: string, context: ParseContext): Parsed<DownloadAssertion> {
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, DOWNLOAD_KINDS);
  if (kind === INVALID) return INVALID;
  if (readRecord(input, path, context.issues, ['kind', 'value']) === INVALID) return INVALID;
  const valuePath = `${path}.value`;
  if (isOneOf(DOWNLOAD_SIZE_KINDS, kind)) {
    const size = readInteger(head['value'], valuePath, context.issues, 0, LARGEST_DOWNLOAD_BYTES);
    // Every file is at least 0 bytes long, so that check would prove nothing.
    if (kind === 'sizeAtLeast' && size === 0) { context.issues.push({ code: 'vacuous', path: valuePath }); return INVALID; }
    return size === INVALID ? INVALID : { kind, value: size };
  }
  if (kind === 'mediaTypeEquals') {
    const mediaType = readPlanText(head['value'], valuePath, context, context.rules.limits.maximumTextLength);
    return mediaType === INVALID ? INVALID : { kind, value: mediaType };
  }
  const value = readExpectedText(head['value'], valuePath, context);
  return value === INVALID ? INVALID : { kind, value };
}

// ---- Calls ----------------------------------------------------------------------------------------

// A name from one of the trusted project's sections of declarations, such as its calls or stubs,
// with the declaration it names. An undeclared name is refused alone: nothing else in the step is
// read against a declaration that does not exist. The error never repeats the name.
function readDeclaredName<Kind extends string, Declaration>(
  input: unknown, path: string, context: ParseContext, section: Readonly<Record<Brand<string, Kind>, Declaration>>,
): Parsed<readonly [Brand<string, Kind>, Declaration]> {
  if (typeof input !== 'string') { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  const found = Object.entries<Declaration>(section).find(([name]) => name === input);
  if (found === undefined) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return [brand<string, Kind>(found[0]), found[1]];
}

// The declaration a call step names.
const readCallName = (input: unknown, path: string, context: ParseContext): Parsed<readonly [CallName, CallDeclaration]> =>
  readDeclaredName<'CallName', CallDeclaration>(input, path, context, context.rules.calls);

// A response field a call or an observed request declares, by its name.
function readDeclaredField(
  input: unknown, path: string, fields: Readonly<Record<FieldName, JsonPointer>> | undefined, context: ParseContext,
): Parsed<FieldName> {
  if (typeof input !== 'string') { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (!Object.hasOwn(fields ?? {}, input)) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return brand<string, 'FieldName'>(input);
}

// One argument, as its parameter's type allows: a secret only by name; anything else as a literal
// value or a run value by name. A literal's type is checked here; a run value's when its text is
// known, by the request builder, under the same rules.
function readCallArgument(input: unknown, path: string, type: ParameterType, context: ParseContext): Parsed<CallArgument> {
  if (type.kind === 'secret') {
    if (isPlainObject(input) && Object.hasOwn(input, 'secretName')) {
      const fields = readRecord(input, path, context.issues, ['secretName']);
      if (fields === INVALID) return INVALID;
      const secretName = readDeclared(fields['secretName'], `${path}.secretName`, context, context.rules.secretNames);
      return secretName === INVALID ? INVALID : { secretName };
    }
    // Literal text in a secret parameter would put the secret in the plan.
    context.issues.push({ code: typeof input === 'string' ? 'literal_secret' : 'wrong_type', path });
    return INVALID;
  }
  if (isPlainObject(input)) {
    if (Object.hasOwn(input, 'valueName')) return readValueReference(input, path, context);
    context.issues.push({ code: 'wrong_type', path });
    return INVALID;
  }
  let value: SafeText | number | boolean;
  if (typeof input === 'string') {
    // The parameter's own length rule applies below, as too_long.
    const text = readPlanText(input, path, context, Number.POSITIVE_INFINITY, 0);
    if (text === INVALID) return INVALID;
    value = text;
  } else if (typeof input === 'number' || typeof input === 'boolean') {
    value = input;
  } else {
    context.issues.push({ code: 'wrong_type', path });
    return INVALID;
  }
  const problem = argumentProblem(type, value);
  if (problem !== undefined) { context.issues.push({ code: problem, path }); return INVALID; }
  return value;
}

// Exactly the declaration's parameters: a missing one and an extra one are both refused. Calls,
// stubs and storage entries all type their arguments this way.
function readCallArguments(
  input: unknown, path: string, declared: Readonly<Record<ParameterName, ParameterType>>, context: ParseContext,
): Parsed<CallArguments> {
  if (!isPlainObject(input)) { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  const parameters = Object.entries(declared);
  const names = parameters.map(([name]) => name);
  if (readRecord(input, path, context.issues, names) === INVALID) return INVALID;
  const entries = parameters.map(([name, type]): Parsed<readonly [string, CallArgument]> => {
    const argument = readCallArgument(input[name], `${path}.${name}`, type, context);
    return argument === INVALID ? INVALID : [name, argument];
  });
  return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

// The response fields a call step remembers, as run values for the steps after it. Each field is
// one the call declares; each name is new, as a remember step's would be.
function readRememberedFields(
  input: unknown, path: string, declaration: CallDeclaration, context: ParseContext,
): Parsed<Readonly<Record<ValueName, FieldName>>> {
  if (!isPlainObject(input)) { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  const declared = Object.keys(declaration.fields ?? {});
  const entries = Object.entries(input).map(([key, field]): Parsed<readonly [ValueName, FieldName]> => {
    const at = `${path}.${key}`;
    const name = readValueName(key, at, context.issues);
    if (name === INVALID) return INVALID;
    if (isNameTaken(name, context)) { context.issues.push({ code: 'duplicate', path: at }); return INVALID; }
    if (typeof field !== 'string') { context.issues.push({ code: 'wrong_type', path: at }); return INVALID; }
    if (!declared.includes(field)) { context.issues.push({ code: 'unknown_value', path: at }); return INVALID; }
    return [name, brand<string, 'FieldName'>(field)];
  });
  if (!allValid(entries)) return INVALID;
  for (const [name] of entries) context.defined.add(name);
  return Object.fromEntries(entries);
}

// A call step. Its remembered values are defined only once its arguments have been read, so it
// cannot use them itself.
function readCall(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<CallStep> {
  const named = readCallName(head['call'], `${path}.call`, context);
  if (named === INVALID) return INVALID;
  const [call, declaration] = named;
  const callArguments = readCallArguments(head['arguments'], `${path}.arguments`, declaration.parameters, context);
  if (!Object.hasOwn(head, 'remember')) return callArguments === INVALID ? INVALID : { type: 'call', call, arguments: callArguments };
  const remember = readRememberedFields(head['remember'], `${path}.remember`, declaration, context);
  return callArguments === INVALID || remember === INVALID ? INVALID : { type: 'call', call, arguments: callArguments, remember };
}

function readBackendAssertion(input: unknown, path: string, context: ParseContext): Parsed<BackendAssertion> {
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, BACKEND_ASSERTION_KINDS);
  if (kind === INVALID) return INVALID;
  if (kind === 'present' || kind === 'absent') return readRecord(input, path, context.issues, ['kind']) === INVALID ? INVALID : { kind };
  if (readRecord(input, path, context.issues, ['kind', 'value']) === INVALID) return INVALID;
  if (kind === 'numberEquals') {
    const value = head['value'];
    if (typeof value !== 'number' || !Number.isFinite(value)) { context.issues.push({ code: 'wrong_type', path: `${path}.value` }); return INVALID; }
    return { kind, value };
  }
  const value = readExpectedText(head['value'], `${path}.value`, context);
  return value === INVALID ? INVALID : { kind, value };
}

// A backend check: a read call, one of its declared fields and a check on it. A write call is
// refused as if it were not declared, since a check may repeat its call.
function readExpectBackend(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<Step> {
  const named = readCallName(head['call'], `${path}.call`, context);
  if (named === INVALID) return INVALID;
  const [call, declaration] = named;
  if (declaration.effect !== 'read') { context.issues.push({ code: 'unknown_value', path: `${path}.call` }); return INVALID; }
  const parts = [
    readCallArguments(head['arguments'], `${path}.arguments`, declaration.parameters, context),
    readDeclaredField(head['field'], `${path}.field`, declaration.fields, context),
    readBackendAssertion(head['assert'], `${path}.assert`, context), readCriterionId(head, path, context),
  ] as const;
  return allValid(parts)
    ? { type: 'expectBackend', call, arguments: parts[0], field: parts[1], assert: parts[2], criterionId: parts[3] }
    : INVALID;
}

// ---- Stubs, request checks and storage --------------------------------------------------------------

const readRequestName = (input: unknown, path: string, context: ParseContext): Parsed<readonly [RequestName, ObservedRequestDeclaration]> =>
  readDeclaredName<'RequestName', ObservedRequestDeclaration>(input, path, context, context.rules.observedRequests);
const readStorageEntryName = (input: unknown, path: string, context: ParseContext): Parsed<readonly [StorageEntryName, StorageEntryDeclaration]> =>
  readDeclaredName<'StorageEntryName', StorageEntryDeclaration>(input, path, context, context.rules.storageEntries);

// Arguments for a stub start or a storage write. Left out of the step when the plan leaves them
// out, and then read as none, so a declaration with parameters still has each one reported missing.
function readOptionalArguments(
  head: Readonly<Record<string, unknown>>, path: string, declared: Readonly<Record<ParameterName, ParameterType>>, context: ParseContext,
): Parsed<{ readonly arguments?: CallArguments }> {
  const given = Object.hasOwn(head, 'arguments');
  const stepArguments = readCallArguments(given ? head['arguments'] : {}, `${path}.arguments`, declared, context);
  if (stepArguments === INVALID) return INVALID;
  return given ? { arguments: stepArguments } : {};
}

// A stub start, with arguments for the stub's parameters, or a stop, with none. A stop names a stub
// an earlier step started, so a plan cannot stop what it never faked.
function readStubStep(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<Step> {
  const named = readDeclaredName<'StubName', StubDeclaration>(head['stub'], `${path}.stub`, context, context.rules.stubs);
  const action = readOneOf(head['action'], `${path}.action`, context.issues, STUB_ACTIONS);
  if (named === INVALID || action === INVALID) return INVALID;
  const [stub, declaration] = named;
  if (action === 'stop') {
    if (Object.hasOwn(head, 'arguments')) { context.issues.push({ code: 'unknown_field', path: `${path}.arguments` }); return INVALID; }
    if (!context.startedStubs.has(stub)) { context.issues.push({ code: 'unknown_value', path: `${path}.stub` }); return INVALID; }
    return { type: 'stub', stub, action };
  }
  context.startedStubs.add(stub);
  const stubArguments = readOptionalArguments(head, path, declaration.parameters, context);
  return stubArguments === INVALID ? INVALID : { type: 'stub', stub, action, ...stubArguments };
}

// How many matching requests a check expects: exactly one of equals, atLeast and atMost.
function readRequestCount(input: unknown, path: string, context: ParseContext): Parsed<RequestCount> {
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = REQUEST_COUNT_KINDS.find((candidate) => Object.hasOwn(head, candidate));
  if (readRecord(input, path, context.issues, kind === undefined ? [] : [kind]) === INVALID || kind === undefined) return INVALID;
  const at = `${path}.${kind}`;
  const count = readInteger(head[kind], at, context.issues, 0, MAXIMUM_EXPECTED_COUNT);
  if (count === INVALID) return INVALID;
  // Any page sends at least 0 requests, so that check would prove nothing.
  if (kind === 'atLeast' && count === 0) { context.issues.push({ code: 'vacuous', path: at }); return INVALID; }
  switch (kind) {
    case 'equals': return { equals: count };
    case 'atLeast': return { atLeast: count };
    case 'atMost': return { atMost: count };
  }
}

// A check on the latest matching exchange: its status, or a field the request declares.
function readResponseAssertion(
  input: unknown, path: string, declaration: ObservedRequestDeclaration, context: ParseContext,
): Parsed<ResponseAssertion> {
  const { issues } = context;
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, issues, RESPONSE_ASSERTION_KINDS);
  if (kind === INVALID) return INVALID;
  if (kind === 'statusEquals') {
    if (readRecord(input, path, issues, ['kind', 'value']) === INVALID) return INVALID;
    const status = readInteger(head['value'], `${path}.value`, issues, RESPONSE_STATUS.lowest, RESPONSE_STATUS.highest);
    return status === INVALID ? INVALID : { kind, value: status };
  }
  const field = (): Parsed<FieldName> => readDeclaredField(head['field'], `${path}.field`, declaration.fields, context);
  if (isOneOf(RESPONSE_FIELD_PRESENCE_KINDS, kind)) {
    if (readRecord(input, path, issues, ['kind', 'field']) === INVALID) return INVALID;
    const checked = field();
    return checked === INVALID ? INVALID : { kind, field: checked };
  }
  if (readRecord(input, path, issues, ['kind', 'field', 'value']) === INVALID) return INVALID;
  const parts = [field(), readExpectedText(head['value'], `${path}.value`, context)] as const;
  return allValid(parts) ? { kind, field: parts[0], value: parts[1] } : INVALID;
}

function readStorageAssertion(input: unknown, path: string, context: ParseContext): Parsed<StorageAssertion> {
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, STORAGE_ASSERTION_KINDS);
  if (kind === INVALID) return INVALID;
  if (kind !== 'equals') return readRecord(input, path, context.issues, ['kind']) === INVALID ? INVALID : { kind };
  if (readRecord(input, path, context.issues, ['kind', 'value']) === INVALID) return INVALID;
  const value = readExpectedText(head['value'], `${path}.value`, context);
  return value === INVALID ? INVALID : { kind, value };
}

// A write or removal of a storage entry the project declares readWrite. An entry declared read may
// only be checked, so writing it is refused as a name the plan may not use there.
function readStorageWrite(
  head: Readonly<Record<string, unknown>>, path: string, type: 'setStorage' | 'removeStorage', context: ParseContext,
): Parsed<Step> {
  const named = readStorageEntryName(head['entry'], `${path}.entry`, context);
  if (named === INVALID) return INVALID;
  const [entry, declaration] = named;
  if (declaration.access !== 'readWrite') { context.issues.push({ code: 'unknown_value', path: `${path}.entry` }); return INVALID; }
  if (type === 'removeStorage') return { type, entry };
  const entryArguments = readOptionalArguments(head, path, declaration.parameters ?? {}, context);
  return entryArguments === INVALID ? INVALID : { type, entry, ...entryArguments };
}

// The steps that name a stub, an observed request or a storage entry.
function readNetworkOrStorageStep(
  head: Readonly<Record<string, unknown>>, path: string, type: NetworkAndStorageStep['type'], context: ParseContext,
): Parsed<Step> {
  switch (type) {
    case 'stub':
      return readStubStep(head, path, context);
    case 'setStorage': case 'removeStorage':
      return readStorageWrite(head, path, type, context);
    case 'expectStorage': {
      const named = readStorageEntryName(head['entry'], `${path}.entry`, context);
      if (named === INVALID) return INVALID;
      const parts = [readStorageAssertion(head['assert'], `${path}.assert`, context), readCriterionId(head, path, context)] as const;
      return allValid(parts) ? { type, entry: named[0], assert: parts[0], criterionId: parts[1] } : INVALID;
    }
    case 'resetRequests': case 'expectRequests': case 'expectResponse': {
      const named = readRequestName(head['request'], `${path}.request`, context);
      if (named === INVALID) return INVALID;
      const [request, declaration] = named;
      if (type === 'resetRequests') return { type, request };
      if (type === 'expectRequests') {
        const parts = [readRequestCount(head['count'], `${path}.count`, context), readCriterionId(head, path, context)] as const;
        return allValid(parts) ? { type, request, count: parts[0], criterionId: parts[1] } : INVALID;
      }
      const parts = [readResponseAssertion(head['assert'], `${path}.assert`, declaration, context), readCriterionId(head, path, context)] as const;
      return allValid(parts) ? { type, request, assert: parts[0], criterionId: parts[1] } : INVALID;
    }
  }
}

// The plan's cleanup: calls only, read after the steps, so they may use the values the steps remember.
function readCleanup(input: unknown, context: ParseContext): Parsed<readonly CallStep[]> {
  const raw = readList(input, '$.cleanup', context.issues, context.rules.limits.maximumSteps, 0);
  if (raw === INVALID) return INVALID;
  const calls = raw.map((entry, index): Parsed<CallStep> => {
    const path = `$.cleanup[${index}]`;
    const head = peekRecord(entry, path, context.issues);
    if (head === INVALID) return INVALID;
    const type = readOneOf(head['type'], `${path}.type`, context.issues, context.grammar.stepTypes, 'unknown_step');
    if (type === INVALID) return INVALID;
    // Nothing inside a misplaced step is read.
    if (!CLEANUP_STEP_TYPES.includes(type)) { context.issues.push({ code: 'misplaced_step', path }); return INVALID; }
    const step = readStep(entry, path, context);
    return step !== INVALID && step.type === 'call' ? step : INVALID;
  });
  return allValid(calls) ? calls : INVALID;
}

function readStep(input: unknown, path: string, context: ParseContext): Parsed<Step> {
  const head = peekRecord(input, path, context.issues);
  if (head === INVALID) return INVALID;
  const type = readOneOf(head['type'], `${path}.type`, context.issues, context.grammar.stepTypes, 'unknown_step');
  if (type === INVALID) return INVALID;
  // A second tab opens only from the plan's own list of steps, so a tab never holds another tab
  // and a frame never opens one. Nothing inside a misplaced tab is read.
  if (type === 'newTab' && !context.topLevel) { context.issues.push({ code: 'misplaced_step', path }); return INVALID; }
  // A call is setup or a check for the whole test, not an action in a page, so neither a frame
  // nor a second tab may hold one.
  if (SERVICE_CALL_STEP_TYPES.includes(type) && !context.topLevel) { context.issues.push({ code: 'misplaced_step', path }); return INVALID; }
  const fields = context.grammar.stepFields[type];
  // The criterion id is checked on its own below, so that a missing one is reported as vacuous.
  const required = fields.required.filter((field) => field !== CRITERION_FIELD);
  if (readRecord(input, path, context.issues, [...fields.required, ...fields.optional], required) === INVALID) return INVALID;
  const locator = (): Parsed<Locator> => readLocator(head['locator'], `${path}.locator`, context);
  const longest = context.rules.limits.maximumTextLength;
  switch (type) {
    case 'navigate': {
      const url = readNavigation(head['url'], `${path}.url`, context);
      // Left out when absent, so a navigate without it stays exactly as it was.
      if (!Object.hasOwn(head, 'scripts')) return url === INVALID ? INVALID : { type, url };
      const scripts = readOneOf(head['scripts'], `${path}.scripts`, context.issues, SCRIPT_MODES);
      return url === INVALID || scripts === INVALID ? INVALID : { type, url, scripts };
    }
    case 'download':
      return readDownload(head, path, context);
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
      const parts = [locator(), readStepList(head['steps'], `${path}.steps`, nested(context))] as const;
      return allValid(parts) ? { type, locator: parts[0], steps: parts[1] } : INVALID;
    }
    case 'newTab': {
      // Frame depth inside a tab counts from the tab, and was checked before the walk began.
      const parts = [
        readNavigation(head['url'], `${path}.url`, context), readStepList(head['steps'], `${path}.steps`, nested(context)),
      ] as const;
      return allValid(parts) ? { type, url: parts[0], steps: parts[1] } : INVALID;
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
    case 'expectDownload': {
      const parts = [
        readDownloadReference(head['download'], `${path}.download`, context),
        readDownloadAssertion(head['assert'], `${path}.assert`, context),
        readCriterionId(head, path, context),
      ] as const;
      return allValid(parts) ? { type, download: parts[0], assert: parts[1], criterionId: parts[2] } : INVALID;
    }
    case 'a11yAudit': {
      const mode = readOneOf(head['mode'], `${path}.mode`, context.issues, AUDIT_MODES);
      return mode === INVALID ? INVALID : { type, mode };
    }
    case 'capture':
      return readCaptureName(head['name'], `${path}.name`, context);
    case 'remember':
      return readRemember(head, path, context);
    case 'call':
      return readCall(head, path, context);
    case 'expectBackend':
      return readExpectBackend(head, path, context);
    case 'stub': case 'resetRequests': case 'expectRequests': case 'expectResponse':
    case 'setStorage': case 'removeStorage': case 'expectStorage':
      return readNetworkOrStorageStep(head, path, type, context);
  }
}

// The context for the steps inside a frame or a second tab: the same plan, below its top level.
const nested = (context: ParseContext): ParseContext => ({ ...context, topLevel: false });

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

// Every step, including the steps inside frames and second tabs, depth first.
function everyStep(steps: readonly Step[]): Step[] {
  return steps.flatMap((step) => (step.type === 'frame' || step.type === 'newTab' ? [step, ...everyStep(step.steps)] : [step]));
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
// measured cheaply and before the parser walks it. Depth counts from the tab, so a second tab at
// the top level starts its frames at depth 0; the parser reads no tab anywhere else, so neither
// does this.
function tooDeepFrame(input: unknown, maximumDepth: number): string | undefined {
  const pending: { readonly steps: unknown; readonly path: string; readonly depth: number; readonly topLevel: boolean }[] = [
    { steps: plainFields(input)?.['steps'], path: '$.steps', depth: 0, topLevel: true },
  ];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (!Array.isArray(next.steps)) continue;
    for (const [index, step] of next.steps.entries()) {
      const fields = plainFields(step);
      const path = `${next.path}[${index}]`;
      if (fields?.['type'] === 'newTab' && next.topLevel) {
        pending.push({ steps: fields['steps'], path: `${path}.steps`, depth: 0, topLevel: false });
      }
      if (fields?.['type'] !== 'frame') continue;
      if (next.depth + 1 > maximumDepth) return path;
      pending.push({ steps: fields['steps'], path: `${path}.steps`, depth: next.depth + 1, topLevel: false });
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
  const context: ParseContext = {
    rules, issues: [], grammar, defined: new Set(), downloads: new Set(), topLevel: true, startedStubs: new Set(),
  };
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
  const cleanup = Object.hasOwn(fields, 'cleanup') ? readCleanup(fields['cleanup'], context) : undefined;
  const storageState = Object.hasOwn(fields, 'storageState') ? readStorageState(fields['storageState'], context) : undefined;
  if (context.issues.length > 0 || meta === INVALID || targets === INVALID || steps === INVALID || storageState === INVALID
    || values === INVALID || clock === INVALID || cleanup === INVALID) return failure(context.issues);
  // Optional fields are left out when absent, so a plan without them hashes as it always did.
  return success({
    version: grammar.version, meta, targets, steps,
    ...(storageState === undefined ? {} : { storageState }),
    ...(values === undefined ? {} : { values }),
    ...(clock === undefined ? {} : { clock }),
    ...(cleanup === undefined ? {} : { cleanup }),
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
  calls: {}, stubs: {}, observedRequests: {}, storageEntries: {},
});

// The run-time half of the brand: the type system stops a forged Plan at compile time, but a cast
// defeats it. run() calls this first, so an object the parser did not make is refused before any
// side effect.
export function assertBranded(plan: unknown): asserts plan is Plan {
  if (typeof plan !== 'object' || plan === null || !PARSED_PLANS.has(plan)) {
    throw new TypeError('refused a plan that the plan parser did not make');
  }
}
