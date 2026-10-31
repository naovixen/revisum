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
// storage key or a value to store. A clock advance is a bounded whole amount of a unit, never a
// wait, and the clipboard can only be checked or remembered, never written.
// See docs/specs/SPEC-01-plan-language-and-parser.md, docs/specs/SPEC-30-plan-values-positions-and-keys.md,
// docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md, docs/specs/SPEC-32-declared-service-calls.md,
// docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md and docs/specs/SPEC-34-clock-advance-and-clipboard.md.
// The unsafe features of version 1.3 (CSS and XPath locators, DOM checks, page scripts and
// database commands) are read only once the trusted project enables each one; a disabled one is
// refused with unsafe_feature_disabled at the field that names it, every use of it, with nothing
// under it read. A selector or expression is literal plan text, so what a locator can match is
// fixed when the plan is approved. See docs/specs/SPEC-36-unsafe-plan-features.md.
import {
  AUDIT_MODES, BACKEND_ASSERTION_KINDS, CALL_EFFECTS, CLIPBOARD_ASSERTION_KINDS, CLIPBOARD_READS, CLOCK_ADVANCE_MODES, CLOCK_UNITS, DIALOG_ACTIONS,
  DOM_CHECK_KINDS, DOWNLOAD_SIZE_KINDS, literalText, ELEMENT_STATE_KINDS, MODIFIERS, PAGE_TEXT_KINDS,
  POSITION_WORDS, REMEMBER_ATTRIBUTE_READ, REMEMBER_READS, REQUEST_COUNT_KINDS, RESPONSE_ASSERTION_KINDS, RESPONSE_FIELD_PRESENCE_KINDS, RESPONSE_READS,
  ROLES, SCRIPT_MODES, STORAGE_ASSERTION_KINDS, STRUCTURAL_LOCATOR_KINDS, STUB_ACTIONS,
  failure, success,
  type CallEffect, type CleanupStep, type CommandName, type DatabaseCommandDeclaration, type InlineScript, type PageScriptDeclaration,
  type ScriptArgument, type ScriptArguments, type ScriptChoice, type ScriptName, type ScriptParameterType, type ScriptSource,
  type StepType, type StructuralLocatorKind, type UnsafeFeature,
  type AllowedUrl, type BackendAssertion, type ClipboardAssertion, type ClockAdvance, type Brand, type CallArgument, type CallArguments, type CallDeclaration, type CallName, type CallStep,
  type CriterionId, type DownloadAssertion, type FieldName, type ParameterName, type ParameterType, type ValueName, type DownloadName, type ElementAssertion, type EmailDomain,
  type FixtureName, type JsonPointer, type Locator,
  type Modifier, type MultiLineText, type NetworkAndStorageStep, type ObservedRequestDeclaration, type Origin, type PageAssertion, type PathTemplate,
  type Plan, type PlanData, type PlanMeta, type Position, type RememberSource, type RequestCount, type RequestName, type ResponseAssertion,
  type Result, type SafeText, type SecretName, type SecretReference, type Step, type StorageAssertion, type StorageEntryDeclaration,
  type StorageEntryName, type StubDeclaration, type StubName, type TargetId, type TestIdAttribute, type TextOrValue, type ValueReference,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import { clockAdvanceMilliseconds } from '../clock-advance.ts';
import { readFields } from '../project/call-declarations.ts';
import { DEFAULT_TEST_ID_ATTRIBUTES, readId, type Limits, type Project } from '../project/project-parser.ts';
import type { TrustedProject } from '../project/trusted-project.ts';
import { declaredCommands, declaredScripts, enabledUnsafeFeatures } from '../project/unsafe-feature-declarations.ts';
import {
  INVALID, allValid, isOneOf, isUnsafeSource, peekRecord, readInteger, readList, readOneOf, readRecord, readText,
  type Issues, type Parsed, type PlanError,
} from './plan-decoders.ts';
import {
  ALL_ELEMENT_KINDS, ASSERTION_STEP_TYPES, ATTRIBUTE_NAME, CAPTURE_NAME, CLASS_TOKEN, CLEANUP_STEP_TYPES, CRITERION_FIELD, CRITERION_ID, CURRENT_GRAMMAR,
  DATABASE_COMMAND_FEATURE, DOM_CHECKS_FEATURE, DOWNLOAD_KINDS, DOWNLOAD_NAME, FEATURE_ID,
  FROM_FIELD, INLINE_SCRIPT_FEATURE, LARGEST_DOWNLOAD_BYTES, LOCATOR_FEATURES, LOCATOR_FIELDS, MAXIMUM_EXPECTED_COUNT, MAXIMUM_INLINE_SCRIPT_LENGTH,
  MAXIMUM_INSIDE_DEPTH, MAXIMUM_META_NAME_LENGTH, MAXIMUM_MODIFIERS, MAXIMUM_PATH_SEGMENTS, MAXIMUM_POSITION, MAXIMUM_QUERY_VALUES,
  MAXIMUM_SELECTOR_LENGTH, MAXIMUM_SPEC_REFERENCE_LENGTH, MAXIMUM_STYLE_VALUE_LENGTH, MAXIMUM_TEST_ID_LENGTH, MAXIMUM_TITLE_LENGTH, MAXIMUM_URL_LENGTH,
  META_FIELDS, NAMED_SCRIPT_FEATURE, PLAN_FIELDS, QUERY_KEY, RESPONSE_STATUS, SELECTOR_FORBIDDEN_CHARACTERS, STYLE_PROPERTY, TOP_LEVEL_STEP_TYPES,
  grammarFor, isDatabaseCommandStepType, isPageScriptStepType, type Grammar,
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
  // The unsafe features the trusted project enables, and the page scripts and database commands
  // a plan may name once their feature is on.
  readonly unsafeFeatures: readonly UnsafeFeature[];
  readonly pageScripts: Readonly<Record<ScriptName, PageScriptDeclaration>>;
  readonly databaseCommands: Readonly<Record<CommandName, DatabaseCommandDeclaration>>;
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
  // How far the advances read so far move the clock, in document order, anywhere in the plan, and
  // whether the plan limit has been passed: only the step that first passes it is refused.
  readonly clockAdvance: { milliseconds: number; limitPassed: boolean };
};

const rulesOf = (project: Project | TrustedProject): PlanRules => ({
  origins: project.origins, targetIds: project.matrix.map((target) => target.id),
  secretNames: project.secretNames, fixtures: project.fixtures, limits: project.limits,
  testIdAttributes: project.testIdAttributes, emailDomains: project.generatedEmailDomains, calls: project.calls,
  stubs: project.stubs, observedRequests: project.observedRequests, storageEntries: project.storageEntries,
  unsafeFeatures: enabledUnsafeFeatures(project.unsafeFeatures), pageScripts: declaredScripts(project.unsafeFeatures),
  databaseCommands: declaredCommands(project.unsafeFeatures),
});

const isPlainObject = (input: unknown): input is Readonly<Record<string, unknown>> =>
  typeof input === 'object' && input !== null && !Array.isArray(input);

// True when the trusted project enables `feature`. A disabled feature is refused at `path`, the
// field that names it, and the caller reads nothing under it, so no part of it is echoed or judged.
function featureEnabled(feature: UnsafeFeature, path: string, context: ParseContext): boolean {
  if (context.rules.unsafeFeatures.includes(feature)) return true;
  context.issues.push({ code: 'unsafe_feature_disabled', path });
  return false;
}

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

const isStructuralKind = (kind: string): kind is StructuralLocatorKind => isOneOf(STRUCTURAL_LOCATOR_KINDS, kind);

// A locator. `insideDepth` counts the `inside` links above it: a CSS or XPath locator chains at
// most MAXIMUM_INSIDE_DEPTH of them, and the one past the limit is refused, with nothing under it read.
function readLocator(input: unknown, path: string, context: ParseContext, insideDepth = 0): Parsed<Locator> {
  const longest = context.rules.limits.maximumTextLength;
  const head = peekRecord(input, path, context.issues);
  if (head === INVALID) return INVALID;
  const by = readOneOf(head['by'], `${path}.by`, context.issues, context.grammar.locatorKinds);
  if (by === INVALID) return INVALID;
  if (isStructuralKind(by) && !featureEnabled(LOCATOR_FEATURES[by], `${path}.by`, context)) return INVALID;
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
    case 'css': case 'xpath': {
      const textField = by === 'css' ? 'selector' : 'expression';
      const selector = readSelectorText(head[textField], `${path}.${textField}`, context);
      const hasText = Object.hasOwn(head, 'hasText') ? readTextOrValue(head['hasText'], `${path}.hasText`, context, longest) : undefined;
      const inside = Object.hasOwn(head, 'inside') ? readInside(head['inside'], `${path}.inside`, context, insideDepth) : undefined;
      if (selector === INVALID || hasText === INVALID || inside === INVALID || position === INVALID) return INVALID;
      // Optional fields are left out when absent.
      const optional = { ...(hasText === undefined ? {} : { hasText }), ...(inside === undefined ? {} : { inside }), ...positioned };
      return by === 'css' ? { by, selector, ...optional } : { by, expression: selector, ...optional };
    }
  }
}

// A CSS selector or XPath expression: literal plan text, never a value reference (wrong_type), of 1
// to MAXIMUM_SELECTOR_LENGTH characters, on one line and with none of "{", "}", ";" and "@"
// (unsafe_text), so what it matches is fixed when the plan is approved.
function readSelectorText(input: unknown, path: string, context: ParseContext): Parsed<SafeText> {
  const text = readPlanText(input, path, context, MAXIMUM_SELECTOR_LENGTH);
  if (text !== INVALID && SELECTOR_FORBIDDEN_CHARACTERS.test(text)) { context.issues.push({ code: 'unsafe_text', path }); return INVALID; }
  return text;
}

// The locator a CSS or XPath locator is evaluated inside, unless the chain is already as deep as it
// may be: then this link is refused with too_large, and nothing under it is read.
function readInside(input: unknown, path: string, context: ParseContext, insideDepth: number): Parsed<Locator> {
  if (insideDepth >= MAXIMUM_INSIDE_DEPTH) { context.issues.push({ code: 'too_large', path }); return INVALID; }
  return readLocator(input, path, context, insideDepth + 1);
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
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, ALL_ELEMENT_KINDS);
  if (kind === INVALID) return INVALID;
  // A kind the declared version does not have is refused as that version's parser refuses it.
  if (!context.grammar.elementKinds.includes(kind)) { context.issues.push({ code: 'unknown_value', path: `${path}.kind` }); return INVALID; }
  if (isOneOf(DOM_CHECK_KINDS, kind)) return featureEnabled(DOM_CHECKS_FEATURE, `${path}.kind`, context) ? readDomCheck(kind, head, path, context) : INVALID;
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

// A literal name that must match `pattern`, such as a class token or an attribute name: never a
// value reference, since it says what the check reads. The error never repeats the name.
function readLiteralName(input: unknown, path: string, context: ParseContext, pattern: RegExp): Parsed<SafeText> {
  const name = readPlanText(input, path, context, Number.POSITIVE_INFINITY);
  if (name !== INVALID && !pattern.test(name)) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return name;
}

// A DOM check, once the project enables them: one class token, a lowercase style property and the
// computed value expected, or an attribute by its lowercase name. Only an attribute's expected
// value may be a value reference; it may be empty, since an attribute set to "" is a real state.
function readDomCheck(
  kind: (typeof DOM_CHECK_KINDS)[number], head: Readonly<Record<string, unknown>>, path: string, context: ParseContext,
): Parsed<ElementAssertion> {
  const { issues } = context;
  switch (kind) {
    case 'hasClass': case 'lacksClass': {
      if (readRecord(head, path, issues, ['kind', 'value']) === INVALID) return INVALID;
      const value = readLiteralName(head['value'], `${path}.value`, context, CLASS_TOKEN);
      return value === INVALID ? INVALID : { kind, value };
    }
    case 'computedStyleEquals': {
      if (readRecord(head, path, issues, ['kind', 'property', 'value']) === INVALID) return INVALID;
      const parts = [
        readLiteralName(head['property'], `${path}.property`, context, STYLE_PROPERTY),
        readPlanText(head['value'], `${path}.value`, context, MAXIMUM_STYLE_VALUE_LENGTH),
      ] as const;
      return allValid(parts) ? { kind, property: parts[0], value: parts[1] } : INVALID;
    }
    case 'attributeEquals': {
      if (readRecord(head, path, issues, ['kind', 'name', 'value']) === INVALID) return INVALID;
      const parts = [
        readLiteralName(head['name'], `${path}.name`, context, ATTRIBUTE_NAME),
        readTextOrValue(head['value'], `${path}.value`, context, context.rules.limits.maximumTextLength, 0),
      ] as const;
      return allValid(parts) ? { kind, name: parts[0], value: parts[1] } : INVALID;
    }
    case 'attributeAbsent': {
      if (readRecord(head, path, issues, ['kind', 'name']) === INVALID) return INVALID;
      const name = readLiteralName(head['name'], `${path}.name`, context, ATTRIBUTE_NAME);
      return name === INVALID ? INVALID : { kind, name };
    }
  }
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

// A criterion id as a plan may write it, such as "AC-3", or undefined when the text is not one. The
// draft command reads a spec's criterion ids with it, so a draft names them as a plan can.
export function criterionIdFrom(text: string): CriterionId | undefined {
  return CRITERION_ID.test(text) && !looksLikeCredential(text) ? brand<string, 'CriterionId'>(text) : undefined;
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
  // The clipboard's plain text, the only clipboard format a plan may read.
  if (isPlainObject(input) && Object.hasOwn(input, 'clipboard')) {
    const fields = readRecord(input, path, issues, ['clipboard']);
    if (fields === INVALID) return INVALID;
    const clipboard = readOneOf(fields['clipboard'], `${path}.clipboard`, issues, CLIPBOARD_READS);
    return clipboard === INVALID ? INVALID : { clipboard };
  }
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
  // One of an element's attributes: a DOM check, so read only once the project enables them.
  if (isPlainObject(input) && input['read'] === REMEMBER_ATTRIBUTE_READ && context.grammar.elementReads.includes(REMEMBER_ATTRIBUTE_READ)) {
    if (!featureEnabled(DOM_CHECKS_FEATURE, `${path}.read`, context)) return INVALID;
    const fields = readRecord(input, path, issues, ['element', 'read', 'attribute']);
    if (fields === INVALID) return INVALID;
    const parts = [
      readLocator(fields['element'], `${path}.element`, context), readLiteralName(fields['attribute'], `${path}.attribute`, context, ATTRIBUTE_NAME),
    ] as const;
    return allValid(parts) ? { element: parts[0], read: REMEMBER_ATTRIBUTE_READ, attribute: parts[1] } : INVALID;
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
  return readPlainArgument(input, path, type, context);
}

// An argument for a parameter that is not a secret: a literal value or a run value by name. A
// secret reference here is the wrong type: a page script or a command never takes one.
function readPlainArgument(input: unknown, path: string, type: ScriptParameterType, context: ParseContext): Parsed<ScriptArgument> {
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

// Exactly the declaration's parameters, each read by `readOne`: a missing one and an extra one are
// both refused. Calls, stubs, storage entries, page scripts and commands all type their arguments
// this way.
function readArgumentsWith<Type, Argument>(
  input: unknown, path: string, declared: Readonly<Record<ParameterName, Type>>, context: ParseContext,
  readOne: (input: unknown, path: string, type: Type, context: ParseContext) => Parsed<Argument>,
): Parsed<Readonly<Record<ParameterName, Argument>>> {
  if (!isPlainObject(input)) { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  const parameters = Object.entries<Type>(declared);
  const names = parameters.map(([name]) => name);
  if (readRecord(input, path, context.issues, names) === INVALID) return INVALID;
  const entries = parameters.map(([name, type]): Parsed<readonly [string, Argument]> => {
    const argument = readOne(input[name], `${path}.${name}`, type, context);
    return argument === INVALID ? INVALID : [name, argument];
  });
  return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

const readCallArguments = (
  input: unknown, path: string, declared: Readonly<Record<ParameterName, ParameterType>>, context: ParseContext,
): Parsed<CallArguments> => readArgumentsWith(input, path, declared, context, readCallArgument);

const readScriptArguments = (
  input: unknown, path: string, declared: Readonly<Record<ParameterName, ScriptParameterType>>, context: ParseContext,
): Parsed<ScriptArguments> => readArgumentsWith(input, path, declared, context, readPlainArgument);

// The fields of a call's response, a script's result or a command's output that a step remembers,
// as run values for the steps after it. Each field is one the declaration gives; each name is new,
// as a remember step's would be.
function readRememberedFields(
  input: unknown, path: string, declaredFields: Readonly<Record<FieldName, JsonPointer>> | undefined, context: ParseContext,
): Parsed<Readonly<Record<ValueName, FieldName>>> {
  if (!isPlainObject(input)) { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  const declared = Object.keys(declaredFields ?? {});
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
  const remember = readRememberedFields(head['remember'], `${path}.remember`, declaration.fields, context);
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

// ---- Page scripts and database commands ---------------------------------------------------------------

// A page-script or database step is read only once its feature is on. A database step needs
// database-command, refused at its type. A named script needs page-script, refused at its type; an
// inline one needs inline-page-script, refused at its `inline`, and a project can enable that only
// together with page-script, so one check covers both.
function unsafeStepEnabled(type: StepType, head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): boolean {
  if (isDatabaseCommandStepType(type)) return featureEnabled(DATABASE_COMMAND_FEATURE, `${path}.type`, context);
  if (!isPageScriptStepType(type)) return true;
  const script = head['script'];
  if (isPlainObject(script) && Object.hasOwn(script, 'inline')) return featureEnabled(INLINE_SCRIPT_FEATURE, `${path}.script.inline`, context);
  return featureEnabled(NAMED_SCRIPT_FEATURE, `${path}.type`, context);
}

// What a step's script is, whether named or inline: its parameters, effect and result fields, and
// where a check that needs a read script reports a write one.
type ScriptUse = {
  readonly script: ScriptChoice;
  readonly parameters: Readonly<Record<ParameterName, ScriptParameterType>>;
  readonly effect: CallEffect;
  readonly fields: Readonly<Record<FieldName, JsonPointer>> | undefined;
  readonly effectPath: string;
};

// A script's source text: 1 to MAXIMUM_INLINE_SCRIPT_LENGTH characters, line breaks allowed, no
// other control characters, and nothing shaped like a credential.
function readScriptSource(input: unknown, path: string, context: ParseContext): Parsed<ScriptSource> {
  const { issues } = context;
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (input.length === 0) { issues.push({ code: 'empty', path }); return INVALID; }
  if (input.length > MAXIMUM_INLINE_SCRIPT_LENGTH) { issues.push({ code: 'too_long', path }); return INVALID; }
  if (isUnsafeSource(input)) { issues.push({ code: 'unsafe_text', path }); return INVALID; }
  if (looksLikeCredential(input)) { issues.push({ code: 'literal_secret', path }); return INVALID; }
  return brand<string, 'ScriptSource'>(input);
}

// An inline script: its source, its effect as the plan claims it, and its result fields. It takes
// no parameters, so its arguments are always {}.
function readInlineScript(input: unknown, path: string, context: ParseContext): Parsed<InlineScript> {
  const fields = readRecord(input, path, context.issues, ['source', 'effect', 'fields'], ['source', 'effect']);
  if (fields === INVALID) return INVALID;
  const resultFields = Object.hasOwn(fields, 'fields') ? readFields(fields['fields'], `${path}.fields`, context.issues) : undefined;
  const parts = [
    readScriptSource(fields['source'], `${path}.source`, context), readOneOf(fields['effect'], `${path}.effect`, context.issues, CALL_EFFECTS),
  ] as const;
  if (!allValid(parts) || resultFields === INVALID) return INVALID;
  return { source: parts[0], effect: parts[1], ...(resultFields === undefined ? {} : { fields: resultFields }) };
}

// The script a step runs: a name the project declares, or { "inline": … }.
function readScriptChoice(input: unknown, path: string, context: ParseContext): Parsed<ScriptUse> {
  if (isPlainObject(input)) {
    const fields = readRecord(input, path, context.issues, ['inline']);
    if (fields === INVALID) return INVALID;
    const inline = readInlineScript(fields['inline'], `${path}.inline`, context);
    if (inline === INVALID) return INVALID;
    return { script: { inline }, parameters: {}, effect: inline.effect, fields: inline.fields, effectPath: `${path}.inline.effect` };
  }
  const named = readDeclaredName<'ScriptName', PageScriptDeclaration>(input, path, context, context.rules.pageScripts);
  if (named === INVALID) return INVALID;
  const [script, declaration] = named;
  return { script, parameters: declaration.parameters, effect: declaration.effect, fields: declaration.fields, effectPath: path };
}

// The command a database step runs, as one of the project's declared commands.
const readCommandName = (input: unknown, path: string, context: ParseContext): Parsed<readonly [CommandName, DatabaseCommandDeclaration]> =>
  readDeclaredName<'CommandName', DatabaseCommandDeclaration>(input, path, context, context.rules.databaseCommands);

// An evaluate step: runs its script, and may remember fields of its result once its arguments are read.
function readEvaluate(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<Step> {
  const use = readScriptChoice(head['script'], `${path}.script`, context);
  if (use === INVALID) return INVALID;
  const scriptArguments = readScriptArguments(head['arguments'], `${path}.arguments`, use.parameters, context);
  if (!Object.hasOwn(head, 'remember')) return scriptArguments === INVALID ? INVALID : { type: 'evaluate', script: use.script, arguments: scriptArguments };
  const remember = readRememberedFields(head['remember'], `${path}.remember`, use.fields, context);
  return scriptArguments === INVALID || remember === INVALID ? INVALID : { type: 'evaluate', script: use.script, arguments: scriptArguments, remember };
}

// A script check: a read script, one of its result fields and a check on it. A write script is
// refused as not declared for this use, since a check may repeat its script.
function readExpectScript(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<Step> {
  const use = readScriptChoice(head['script'], `${path}.script`, context);
  if (use === INVALID) return INVALID;
  if (use.effect !== 'read') { context.issues.push({ code: 'unknown_value', path: use.effectPath }); return INVALID; }
  const parts = [
    readScriptArguments(head['arguments'], `${path}.arguments`, use.parameters, context),
    readDeclaredField(head['field'], `${path}.field`, use.fields, context),
    readBackendAssertion(head['assert'], `${path}.assert`, context), readCriterionId(head, path, context),
  ] as const;
  return allValid(parts)
    ? { type: 'expectScript', script: use.script, arguments: parts[0], field: parts[1], assert: parts[2], criterionId: parts[3] }
    : INVALID;
}

// A database step: runs a declared command, and may remember fields of its JSON output.
function readDatabase(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<Step> {
  const named = readCommandName(head['command'], `${path}.command`, context);
  if (named === INVALID) return INVALID;
  const [command, declaration] = named;
  const commandArguments = readScriptArguments(head['arguments'], `${path}.arguments`, declaration.parameters, context);
  if (!Object.hasOwn(head, 'remember')) return commandArguments === INVALID ? INVALID : { type: 'database', command, arguments: commandArguments };
  const remember = readRememberedFields(head['remember'], `${path}.remember`, declaration.fields, context);
  return commandArguments === INVALID || remember === INVALID ? INVALID : { type: 'database', command, arguments: commandArguments, remember };
}

// A database check: a read command, one of its output fields and a check on it. A write command is
// refused as not declared for this use, since a check may repeat its command.
function readExpectDatabase(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<Step> {
  const named = readCommandName(head['command'], `${path}.command`, context);
  if (named === INVALID) return INVALID;
  const [command, declaration] = named;
  if (declaration.effect !== 'read') { context.issues.push({ code: 'unknown_value', path: `${path}.command` }); return INVALID; }
  const parts = [
    readScriptArguments(head['arguments'], `${path}.arguments`, declaration.parameters, context),
    readDeclaredField(head['field'], `${path}.field`, declaration.fields, context),
    readBackendAssertion(head['assert'], `${path}.assert`, context), readCriterionId(head, path, context),
  ] as const;
  return allValid(parts)
    ? { type: 'expectDatabase', command, arguments: parts[0], field: parts[1], assert: parts[2], criterionId: parts[3] }
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

// ---- The clock and the clipboard ----------------------------------------------------------------------

// A whole amount of at least 1 of a unit, within the project's step limit. A missing amount is the
// wrong type, as any other non-whole amount is. An amount too large for its unit is refused with
// too_large, never echoed.
function readClockAdvance(input: unknown, path: string, context: ParseContext): Parsed<ClockAdvance> {
  const fields = readRecord(input, path, context.issues, ['amount', 'unit'], ['unit']);
  if (fields === INVALID) return INVALID;
  const amountPath = `${path}.amount`;
  const raw = fields['amount'];
  const amount = typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : INVALID;
  if (amount === INVALID) context.issues.push({ code: 'wrong_type', path: amountPath });
  const unit = readOneOf(fields['unit'], `${path}.unit`, context.issues, CLOCK_UNITS);
  if (amount === INVALID || unit === INVALID) return INVALID;
  const by = { amount, unit };
  if (clockAdvanceMilliseconds(by) > context.rules.limits.maximumClockAdvanceMilliseconds) {
    context.issues.push({ code: 'too_large', path: amountPath });
    return INVALID;
  }
  return by;
}

// Adds an advance to the plan's total. Plans are straight-line, so the total is exactly how far
// the run's clock moves; the step at which it first passes the plan limit is refused, and only
// that one. False when this step is it.
function addClockAdvance(by: ClockAdvance, path: string, context: ParseContext): boolean {
  const total = context.clockAdvance;
  total.milliseconds += clockAdvanceMilliseconds(by);
  if (total.limitPassed || total.milliseconds <= context.rules.limits.maximumTotalClockAdvanceMilliseconds) return true;
  total.limitPassed = true;
  context.issues.push({ code: 'too_large', path });
  return false;
}

// An advance of the run's virtual clock. The mode is left out when absent, so the step stays as written.
function readAdvanceClock(head: Readonly<Record<string, unknown>>, path: string, context: ParseContext): Parsed<Step> {
  const by = readClockAdvance(head['by'], `${path}.by`, context);
  const mode = Object.hasOwn(head, 'mode') ? readOneOf(head['mode'], `${path}.mode`, context.issues, CLOCK_ADVANCE_MODES) : undefined;
  if (by === INVALID || mode === INVALID || !addClockAdvance(by, path, context)) return INVALID;
  return { type: 'advanceClock', by, ...(mode === undefined ? {} : { mode }) };
}

// Expected clipboard text written as lines, within the fill limits. A single empty line is empty
// text, which would make the check vacuous.
function readExpectedLines(input: unknown, path: string, context: ParseContext): Parsed<MultiLineText> {
  const lines = readMultiLineText(input, path, context);
  if (lines !== INVALID && lines.lines.length === 1 && lines.lines[0] === '') { context.issues.push({ code: 'vacuous', path }); return INVALID; }
  return lines;
}

// A check on the clipboard's plain text. Only textEquals compares against several lines; for
// textContains and textExcludes, lines are the wrong type of value.
function readClipboardAssertion(input: unknown, path: string, context: ParseContext): Parsed<ClipboardAssertion> {
  const head = readAssertionHead(input, path, context);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, context.issues, CLIPBOARD_ASSERTION_KINDS);
  if (kind === INVALID) return INVALID;
  if (readRecord(input, path, context.issues, ['kind', 'value']) === INVALID) return INVALID;
  const valuePath = `${path}.value`;
  const value = head['value'];
  const writtenAsLines = isPlainObject(value) && Object.hasOwn(value, 'lines');
  if (writtenAsLines && kind === 'textEquals') {
    const lines = readExpectedLines(value, valuePath, context);
    return lines === INVALID ? INVALID : { kind, value: lines };
  }
  if (writtenAsLines) { context.issues.push({ code: 'wrong_type', path: valuePath }); return INVALID; }
  const expected = readExpectedText(value, valuePath, context);
  return expected === INVALID ? INVALID : { kind, value: expected };
}

// The plan's cleanup: calls and database commands only, read after the steps, so they may use the
// values the steps remember.
function readCleanup(input: unknown, context: ParseContext): Parsed<readonly CleanupStep[]> {
  const raw = readList(input, '$.cleanup', context.issues, context.rules.limits.maximumSteps, 0);
  if (raw === INVALID) return INVALID;
  const calls = raw.map((entry, index): Parsed<CleanupStep> => {
    const path = `$.cleanup[${index}]`;
    const head = peekRecord(entry, path, context.issues);
    if (head === INVALID) return INVALID;
    const type = readOneOf(head['type'], `${path}.type`, context.issues, context.grammar.stepTypes, 'unknown_step');
    if (type === INVALID) return INVALID;
    // Nothing inside a misplaced step is read.
    if (!CLEANUP_STEP_TYPES.includes(type)) { context.issues.push({ code: 'misplaced_step', path }); return INVALID; }
    const step = readStep(entry, path, context);
    return step !== INVALID && (step.type === 'call' || step.type === 'database') ? step : INVALID;
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
  // A call or a database command is setup or a check for the whole test, not an action in a page,
  // so neither a frame nor a second tab may hold one.
  if (TOP_LEVEL_STEP_TYPES.includes(type) && !context.topLevel) { context.issues.push({ code: 'misplaced_step', path }); return INVALID; }
  if (!unsafeStepEnabled(type, head, path, context)) return INVALID;
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
    case 'advanceClock':
      return readAdvanceClock(head, path, context);
    case 'expectClipboard': {
      const parts = [readClipboardAssertion(head['assert'], `${path}.assert`, context), readCriterionId(head, path, context)] as const;
      return allValid(parts) ? { type, assert: parts[0], criterionId: parts[1] } : INVALID;
    }
    case 'evaluate':
      return readEvaluate(head, path, context);
    case 'expectScript':
      return readExpectScript(head, path, context);
    case 'database':
      return readDatabase(head, path, context);
    case 'expectDatabase':
      return readExpectDatabase(head, path, context);
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
    clockAdvance: { milliseconds: 0, limitPassed: false },
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
// A project read by the project parser, or the trusted project read from the protected branch.
export function planParser(project: Project | TrustedProject): (input: unknown) => Result<Plan, readonly PlanError[]> {
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
  calls: {}, stubs: {}, observedRequests: {}, storageEntries: {}, unsafeFeatures: [], pageScripts: {}, databaseCommands: {},
});

// The run-time half of the brand: the type system stops a forged Plan at compile time, but a cast
// defeats it. run() calls this first, so an object the parser did not make is refused before any
// side effect.
export function assertBranded(plan: unknown): asserts plan is Plan {
  if (typeof plan !== 'object' || plan === null || !PARSED_PLANS.has(plan)) {
    throw new TypeError('refused a plan that the plan parser did not make');
  }
}
