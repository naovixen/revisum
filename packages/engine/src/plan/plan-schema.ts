// The plan language's published JSON Schema (2020-12), for agents and editors that draft plans.
// It is built from the same tables the plan parser decodes with, so the two describe one language.
// A plan that fits the schema can still be refused: the parser also checks the project's
// allow-list, matrix, secret names, fixtures, test-id attributes and email domains, its limits,
// the text safety rules, that values and downloads are defined before use, that a second tab
// and a call open only at the top level, that a call and its arguments and fields fit the
// project's declarations, that each stub, observed request, storage entry and field is one the
// project declares, that each clock advance and the plan's advances together fit the project's
// limits, and that a plan declaring "1.1" uses nothing 1.2 added. Passing the schema is never a
// reason to trust a plan.
// `npm run lint` checks that docs/plan-language/plan.schema.json is exactly this schema.
// See docs/specs/SPEC-01-plan-language-and-parser.md, docs/specs/SPEC-30-plan-values-positions-and-keys.md
// docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md, docs/specs/SPEC-32-declared-service-calls.md
// and docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import {
  AUDIT_MODES, BACKEND_ASSERTION_KINDS, CLIPBOARD_ASSERTION_KINDS, CLIPBOARD_READS, CLOCK_ADVANCE_MODES, CLOCK_UNITS, DATE_ANCHORS, DATE_FORMATS, DIALOG_ACTIONS, DOWNLOAD_TEXT_KINDS, ELEMENT_STATE_KINDS, ELEMENT_TEXT_KINDS, KEYS,
  LOCATOR_KINDS, MODIFIERS, PAGE_TEXT_KINDS, POSITION_WORDS, REMEMBER_READS, RESPONSE_FIELD_PRESENCE_KINDS, RESPONSE_FIELD_TEXT_KINDS,
  RESPONSE_READS, ROLES, SCRIPT_MODES, STORAGE_ASSERTION_KINDS, STUB_ACTIONS,
  type StepType,
} from '@revisum/contracts';
import { schemaId } from '../version.ts';
import {
  DECLARED_NAME, CAPTURE_NAME, CLOCK_TIME, CRITERION_FIELD, CRITERION_ID, CURRENT_PLAN_VERSION, DOWNLOAD_NAME, EMAIL_LOCAL_PREFIX, FEATURE_ID, FROM_FIELD,
  LARGEST_DOWNLOAD_BYTES, LOCATOR_FIELDS, LOWERCASE_ID, MAXIMUM_DAY_OFFSET, MAXIMUM_EXPECTED_COUNT, MAXIMUM_META_NAME_LENGTH,
  MAXIMUM_MODIFIERS, MAXIMUM_PATH_SEGMENTS, MAXIMUM_POSITION,
  MAXIMUM_SPEC_REFERENCE_LENGTH, MAXIMUM_TEST_ID_LENGTH, MAXIMUM_TITLE_LENGTH, MAXIMUM_URL_LENGTH, MAXIMUM_VALUE_PREFIX_LENGTH,
  META_FIELDS, OPTIONAL_LOCATOR_FIELDS, PLAN_FIELDS, PREVIOUS_PLAN_VERSION, QUERY_KEY, RESPONSE_STATUS, STEP_FIELDS, STEP_TYPES, UNIQUE_NUMBER_DIGITS,
  VALUE_NAME,
} from './plan-grammar.ts';

// A JSON Schema document or part of one. Plain JSON values only, so it serialises exactly.
export type JsonSchema = { readonly [keyword: string]: JsonValue };
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// JSON Schema's own keywords, such as minLength, are written as quoted keys: they are the
// standard's vocabulary, not names of ours.
const reference = (name: string): JsonSchema => ({ '$ref': `#/$defs/${name}` });

// No control or bidirectional-override characters. The parser's script rules are not expressed here.
const UNSAFE_CHARACTERS = '\\u0000-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069';
const SAFE_TEXT_PATTERN = `^[^${UNSAFE_CHARACTERS}]*$`;
const text = (minimumLength: number, maximumLength?: number): JsonSchema => ({
  type: 'string', 'minLength': minimumLength, ...(maximumLength === undefined ? {} : { 'maxLength': maximumLength }), pattern: SAFE_TEXT_PATTERN,
});
// Literal text, or a reference to a run value. The two never overlap: one is a string, the other an object.
const textOrValue = (minimumLength: number, maximumLength?: number): JsonSchema =>
  ({ oneOf: [text(minimumLength, maximumLength), reference('valueReference')] });
const integer = (minimum: number, maximum: number): JsonSchema => ({ type: 'integer', minimum, maximum });

// A closed object: only the named properties, with `required` among them.
function closedObject(properties: Readonly<Record<string, JsonSchema>>, required: readonly string[]): JsonSchema {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}
// An object whose keys follow `keyPattern` and whose values all fit `values`.
const recordOf = (keyPattern: RegExp, values: JsonSchema): JsonSchema =>
  ({ type: 'object', propertyNames: { pattern: keyPattern.source }, additionalProperties: values });

// A reference to a secret the project declares, as a fill value or saved storage state.
const SECRET_REFERENCE: JsonSchema = closedObject({ secretName: { type: 'string', 'minLength': 1 } }, ['secretName']);

// The schema of each field a step may hold, by field name. A step's own table entry lists which it has.
const STEP_FIELD_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  url: { oneOf: [reference('url'), reference('pathTemplate')] },
  locator: reference('locator'),
  value: { oneOf: [text(0), SECRET_REFERENCE, reference('valueReference'), reference('multiLineText')] },
  option: textOrValue(1),
  fixture: { type: 'string', 'minLength': 1 },
  key: { enum: [...KEYS] },
  modifiers: { type: 'array', items: { enum: [...MODIFIERS] }, 'minItems': 1, 'maxItems': MAXIMUM_MODIFIERS, 'uniqueItems': true },
  steps: reference('steps'),
  action: { enum: [...DIALOG_ACTIONS] },
  expectText: textOrValue(1),
  [CRITERION_FIELD]: { type: 'string', pattern: CRITERION_ID.source },
  mode: { enum: [...AUDIT_MODES] },
  name: { type: 'string', pattern: CAPTURE_NAME.source },
  // An element of the page, a field of the latest response a declared request check saw, or the
  // clipboard's plain text.
  from: {
    oneOf: [
      closedObject({ clipboard: { enum: [...CLIPBOARD_READS] } }, ['clipboard']),
      closedObject({ element: reference('locator'), read: { enum: [...REMEMBER_READS] } }, ['element', 'read']),
      closedObject({
        response: { type: 'string', pattern: DECLARED_NAME.source }, field: { type: 'string', pattern: DECLARED_NAME.source },
        read: { enum: [...RESPONSE_READS] },
      }, ['response', 'field', 'read']),
    ],
  },
  scripts: { enum: [...SCRIPT_MODES] },
  download: { type: 'string', pattern: DOWNLOAD_NAME.source },
  call: { type: 'string', pattern: DECLARED_NAME.source },
  // The project declares each call's parameters; the parser checks the arguments against them.
  arguments: recordOf(DECLARED_NAME, { oneOf: [text(0), { type: 'number' }, { type: 'boolean' }, reference('valueReference'), SECRET_REFERENCE] }),
  remember: recordOf(VALUE_NAME, { type: 'string', pattern: DECLARED_NAME.source }),
  field: { type: 'string', pattern: DECLARED_NAME.source },
  // The project declares each stub, observed request and storage entry; the parser checks the names.
  stub: { type: 'string', pattern: DECLARED_NAME.source },
  request: { type: 'string', pattern: DECLARED_NAME.source },
  entry: { type: 'string', pattern: DECLARED_NAME.source },
  count: reference('requestCount'),
  // A whole amount of at least 1 of a unit. The parser checks it against the project's limits.
  by: closedObject({ amount: { type: 'integer', minimum: 1 }, unit: { enum: [...CLOCK_UNITS] } }, ['amount', 'unit']),
};

// Step fields whose schema depends on the step type.
const STEP_TYPE_FIELD_SCHEMAS: { readonly [Type in StepType]?: Readonly<Record<string, JsonSchema>> } = {
  expect: { assert: reference('elementAssertion') },
  expectPage: { assert: reference('pageAssertion') },
  remember: { name: { type: 'string', pattern: VALUE_NAME.source } },
  download: { name: { type: 'string', pattern: DOWNLOAD_NAME.source } },
  expectDownload: { assert: reference('downloadAssertion') },
  expectBackend: { assert: reference('backendAssertion') },
  stub: { action: { enum: [...STUB_ACTIONS] } },
  expectResponse: { assert: reference('responseAssertion') },
  expectStorage: { assert: reference('storageAssertion') },
  advanceClock: { mode: { enum: [...CLOCK_ADVANCE_MODES] } },
  expectClipboard: { assert: reference('clipboardAssertion') },
};

function stepSchema(type: StepType): JsonSchema {
  const fields = STEP_FIELDS[type];
  const properties: Record<string, JsonSchema> = { type: { const: type } };
  for (const field of [...fields.required, ...fields.optional]) {
    const schema = STEP_TYPE_FIELD_SCHEMAS[type]?.[field] ?? STEP_FIELD_SCHEMAS[field];
    if (field !== 'type' && schema !== undefined) properties[field] = schema;
  }
  return closedObject(properties, fields.required);
}

const LOCATOR_FIELD_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  role: { enum: [...ROLES] },
  name: textOrValue(1),
  label: textOrValue(1),
  text: textOrValue(1),
  testId: textOrValue(1, MAXIMUM_TEST_ID_LENGTH),
  // The project declares which attributes; the parser checks the name against that list.
  attribute: { type: 'string', 'minLength': 1 },
  position: { oneOf: [{ enum: [...POSITION_WORDS] }, integer(1, MAXIMUM_POSITION)] },
};

function locatorSchema(kind: (typeof LOCATOR_KINDS)[number]): JsonSchema {
  const properties: Record<string, JsonSchema> = { by: { const: kind } };
  for (const field of [...LOCATOR_FIELDS[kind], ...OPTIONAL_LOCATOR_FIELDS[kind]]) {
    const schema = LOCATOR_FIELD_SCHEMAS[field];
    if (schema !== undefined) properties[field] = schema;
  }
  return closedObject(properties, LOCATOR_FIELDS[kind]);
}

// The values a plan generates for each run. The parser checks a unique email's domain against
// the project's list.
const GENERATED_VALUE: JsonSchema = {
  oneOf: [
    closedObject({ kind: { const: 'uniqueText' }, prefix: text(1, MAXIMUM_VALUE_PREFIX_LENGTH) }, ['kind', 'prefix']),
    closedObject({
      kind: { const: 'uniqueEmail' }, localPrefix: { type: 'string', pattern: EMAIL_LOCAL_PREFIX.source }, domain: { type: 'string', 'minLength': 1 },
    }, ['kind', 'localPrefix']),
    closedObject({ kind: { const: 'uniqueNumber' }, digits: integer(UNIQUE_NUMBER_DIGITS.fewest, UNIQUE_NUMBER_DIGITS.most) }, ['kind', 'digits']),
    closedObject({ kind: { const: 'date' }, day: reference('relativeDay'), format: { enum: [...DATE_FORMATS] } }, ['kind', 'day', 'format']),
  ],
};

// A literal path segment: no separator that would add a segment or start a query or fragment.
const LITERAL_SEGMENT: JsonSchema = { type: 'string', 'minLength': 1, pattern: `^[^/?#${UNSAFE_CHARACTERS}]*$` };

// Builds the schema. The same bytes every time: nothing in it depends on the clock or the machine.
export function planJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: schemaId('plan', 1),
    title: `Plan language ${CURRENT_PLAN_VERSION}`,
    description: 'A closed, versioned test plan. Every assertion names the acceptance criterion it checks. '
      + `A plan declaring "${PREVIOUS_PLAN_VERSION}" may use only what that version had. `
      + 'Fitting this schema is necessary, not sufficient: the plan parser also checks the project\'s allow-list, '
      + 'matrix, declared secrets, fixtures, test-id attributes and email domains, its limits, its text safety rules '
      + 'that every value and download is defined before it is used, that a second tab and a call stand only at the top level, '
      + 'and that each call, stub, observed request, storage entry, argument and field is one the project declares.',
    ...closedObject({
      version: { enum: [PREVIOUS_PLAN_VERSION, CURRENT_PLAN_VERSION] },
      meta: closedObject({
        featureId: { type: 'string', pattern: FEATURE_ID.source },
        specReference: text(1, MAXIMUM_SPEC_REFERENCE_LENGTH),
        title: text(1, MAXIMUM_TITLE_LENGTH),
      }, META_FIELDS),
      targets: { type: 'array', items: { type: 'string', pattern: LOWERCASE_ID.source }, 'minItems': 1, 'uniqueItems': true },
      steps: reference('steps'),
      // Saved browser storage state, by secret name. The JSON itself never appears in a plan.
      storageState: SECRET_REFERENCE,
      // Values generated for each run, by name.
      values: recordOf(VALUE_NAME, GENERATED_VALUE),
      // The page's frozen clock, relative to the run's clock start.
      clock: closedObject({ day: reference('relativeDay'), time: { type: 'string', pattern: CLOCK_TIME.source } }, ['day', 'time']),
      // Calls run in order after the steps, whatever the outcome.
      cleanup: { type: 'array', items: reference('callStep') },
    }, PLAN_FIELDS),
    $defs: {
      steps: { type: 'array', items: reference('step'), 'minItems': 1 },
      step: { oneOf: STEP_TYPES.map((type) => reference(`${type}Step`)) },
      ...Object.fromEntries(STEP_TYPES.map((type) => [`${type}Step`, stepSchema(type)])),
      locator: { oneOf: LOCATOR_KINDS.map((kind) => locatorSchema(kind)) },
      elementAssertion: {
        oneOf: [
          closedObject({ kind: { enum: [...ELEMENT_STATE_KINDS] } }, ['kind']),
          closedObject({ kind: { enum: [...ELEMENT_TEXT_KINDS] }, value: textOrValue(1) }, ['kind', 'value']),
          closedObject({ kind: { const: 'countEquals' }, value: integer(0, MAXIMUM_EXPECTED_COUNT) }, ['kind', 'value']),
          closedObject({ kind: { const: 'hrefEquals' }, value: { oneOf: [reference('comparedUrl'), reference('valueReference')] } }, ['kind', 'value']),
        ],
      },
      pageAssertion: {
        oneOf: [
          closedObject({ kind: { enum: [...PAGE_TEXT_KINDS] }, value: text(0) }, ['kind', 'value']),
          closedObject({ kind: { const: 'url' }, value: reference('url') }, ['kind', 'value']),
          closedObject({
            kind: { const: 'urlPathStartsWith' },
            value: { type: 'string', 'maxLength': MAXIMUM_URL_LENGTH, pattern: `^/[^${UNSAFE_CHARACTERS}]*$` },
          }, ['kind', 'value']),
          closedObject({
            kind: { const: 'metaContent' }, name: text(1, MAXIMUM_META_NAME_LENGTH), value: textOrValue(1),
          }, ['kind', 'name', 'value']),
          closedObject({ kind: { const: 'canonicalUrl' }, value: reference('comparedUrl') }, ['kind', 'value']),
        ],
      },
      // Checks on a downloaded file; sizes are in bytes.
      downloadAssertion: {
        oneOf: [
          closedObject({ kind: { enum: [...DOWNLOAD_TEXT_KINDS] }, value: textOrValue(1) }, ['kind', 'value']),
          closedObject({ kind: { const: 'mediaTypeEquals' }, value: text(1) }, ['kind', 'value']),
          closedObject({ kind: { const: 'sizeAtMost' }, value: integer(0, LARGEST_DOWNLOAD_BYTES) }, ['kind', 'value']),
          closedObject({ kind: { const: 'sizeAtLeast' }, value: integer(1, LARGEST_DOWNLOAD_BYTES) }, ['kind', 'value']),
        ],
      },
      // A check on one field of a declared read call's response.
      backendAssertion: {
        oneOf: [
          closedObject({ kind: { enum: BACKEND_ASSERTION_KINDS.filter((kind) => kind === 'present' || kind === 'absent') } }, ['kind']),
          closedObject({
            kind: { enum: BACKEND_ASSERTION_KINDS.filter((kind) => kind === 'equals' || kind === 'contains') }, value: textOrValue(1),
          }, ['kind', 'value']),
          closedObject({ kind: { const: 'numberEquals' }, value: { type: 'number' } }, ['kind', 'value']),
        ],
      },
      // How many matching requests a check expects. atLeast 0 would hold for any page.
      requestCount: {
        oneOf: [
          closedObject({ equals: integer(0, MAXIMUM_EXPECTED_COUNT) }, ['equals']),
          closedObject({ atLeast: integer(1, MAXIMUM_EXPECTED_COUNT) }, ['atLeast']),
          closedObject({ atMost: integer(0, MAXIMUM_EXPECTED_COUNT) }, ['atMost']),
        ],
      },
      // A check on the latest exchange a declared request check saw: its status or a declared field.
      responseAssertion: {
        oneOf: [
          closedObject({ kind: { const: 'statusEquals' }, value: integer(RESPONSE_STATUS.lowest, RESPONSE_STATUS.highest) }, ['kind', 'value']),
          closedObject({ kind: { enum: [...RESPONSE_FIELD_PRESENCE_KINDS] }, field: { type: 'string', pattern: DECLARED_NAME.source } }, ['kind', 'field']),
          closedObject({
            kind: { enum: [...RESPONSE_FIELD_TEXT_KINDS] }, field: { type: 'string', pattern: DECLARED_NAME.source }, value: textOrValue(1),
          }, ['kind', 'field', 'value']),
        ],
      },
      // A check on a declared storage entry.
      storageAssertion: {
        oneOf: [
          closedObject({ kind: { enum: STORAGE_ASSERTION_KINDS.filter((kind) => kind !== 'equals') } }, ['kind']),
          closedObject({ kind: { const: 'equals' }, value: textOrValue(1) }, ['kind', 'value']),
        ],
      },
      // A check on the clipboard's plain text. Only textEquals compares against several lines.
      clipboardAssertion: {
        oneOf: [
          closedObject({
            kind: { const: 'textEquals' }, value: { oneOf: [text(1), reference('valueReference'), reference('multiLineText')] },
          }, ['kind', 'value']),
          closedObject({ kind: { enum: CLIPBOARD_ASSERTION_KINDS.filter((kind) => kind !== 'textEquals') }, value: textOrValue(1) }, ['kind', 'value']),
        ],
      },
      // A URL a check compares and never visits: a path starting with "/", or an absolute http or
      // https URL of any origin.
      comparedUrl: { type: 'string', 'minLength': 1, 'maxLength': MAXIMUM_URL_LENGTH, pattern: '^(/|https?://)' },
      // A path starting with "/", or an absolute http or https URL. The parser checks the origin.
      url: { type: 'string', 'minLength': 1, 'maxLength': MAXIMUM_URL_LENGTH, pattern: '^(/|https?://)' },
      // A path on the run's base URL. It has no origin field, so no value can change where it goes.
      pathTemplate: closedObject({
        segments: {
          type: 'array', items: { oneOf: [LITERAL_SEGMENT, reference('valueReference')] }, 'minItems': 1, 'maxItems': MAXIMUM_PATH_SEGMENTS,
        },
        query: recordOf(QUERY_KEY, textOrValue(0)),
      }, ['segments']),
      valueReference: closedObject({ valueName: { type: 'string', pattern: VALUE_NAME.source } }, ['valueName']),
      multiLineText: closedObject({ lines: { type: 'array', items: textOrValue(0), 'minItems': 1 } }, ['lines']),
      relativeDay: closedObject({ from: { enum: [...DATE_ANCHORS] }, addDays: integer(-MAXIMUM_DAY_OFFSET, MAXIMUM_DAY_OFFSET) }, [FROM_FIELD, 'addDays']),
    },
  };
}
