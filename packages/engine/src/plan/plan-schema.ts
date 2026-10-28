// The plan language's published JSON Schema (2020-12), for agents and editors that draft plans.
// It is built from the same tables the plan parser decodes with, so the two describe one language.
// A plan that fits the schema can still be refused: the parser also checks the project's
// allow-list, matrix, secret names and fixtures, its limits and the text safety rules. Passing the
// schema is never a reason to trust a plan.
// `npm run lint` checks that docs/plan-language/plan.schema.json is exactly this schema.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import {
  AUDIT_MODES, DIALOG_ACTIONS, ELEMENT_STATE_KINDS, ELEMENT_TEXT_KINDS, KEYS, LOCATOR_KINDS, PAGE_TEXT_KINDS, ROLES,
  type StepType,
} from '@revisum/contracts';
import { schemaId } from '../version.ts';
import {
  CAPTURE_NAME, CRITERION_FIELD, CRITERION_ID, CURRENT_PLAN_VERSION, FEATURE_ID, LOCATOR_FIELDS, LOWERCASE_ID,
  MAXIMUM_EXPECTED_COUNT, MAXIMUM_SPEC_REFERENCE_LENGTH, MAXIMUM_TEST_ID_LENGTH, MAXIMUM_TITLE_LENGTH, MAXIMUM_URL_LENGTH,
  META_FIELDS, PLAN_FIELDS, STEP_FIELDS, STEP_TYPES,
} from './plan-grammar.ts';

// A JSON Schema document or part of one. Plain JSON values only, so it serialises exactly.
export type JsonSchema = { readonly [keyword: string]: JsonValue };
type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

// JSON Schema's own keywords, such as minLength, are written as quoted keys: they are the
// standard's vocabulary, not names of ours.
const reference = (name: string): JsonSchema => ({ '$ref': `#/$defs/${name}` });

// No control or bidirectional-override characters. The parser's script rules are not expressed here.
const SAFE_TEXT_PATTERN = '^[^\\u0000-\\u001f\\u007f\\u202a-\\u202e\\u2066-\\u2069]*$';
const text = (minimumLength: number, maximumLength?: number): JsonSchema => ({
  type: 'string', 'minLength': minimumLength, ...(maximumLength === undefined ? {} : { 'maxLength': maximumLength }), pattern: SAFE_TEXT_PATTERN,
});

// A closed object: only the named properties, with `required` among them.
function closedObject(properties: Readonly<Record<string, JsonSchema>>, required: readonly string[]): JsonSchema {
  return { type: 'object', properties, required: [...required], additionalProperties: false };
}

// A reference to a secret the project declares, as a fill value or saved storage state.
const SECRET_REFERENCE: JsonSchema = closedObject({ secretName: { type: 'string', 'minLength': 1 } }, ['secretName']);

// The schema of each field a step may hold, by field name. A step's own table entry lists which it has.
const STEP_FIELD_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  url: reference('url'),
  locator: reference('locator'),
  value: { oneOf: [text(0), SECRET_REFERENCE] },
  option: text(1),
  fixture: { type: 'string', 'minLength': 1 },
  key: { enum: [...KEYS] },
  steps: reference('steps'),
  action: { enum: [...DIALOG_ACTIONS] },
  expectText: text(1),
  [CRITERION_FIELD]: { type: 'string', pattern: CRITERION_ID.source },
  mode: { enum: [...AUDIT_MODES] },
  name: { type: 'string', pattern: CAPTURE_NAME.source },
};

// Step fields whose schema depends on the step type.
const ASSERTION_SCHEMAS: { readonly [Type in StepType]?: Readonly<Record<string, JsonSchema>> } = {
  expect: { assert: reference('elementAssertion') },
  expectPage: { assert: reference('pageAssertion') },
};

function stepSchema(type: StepType): JsonSchema {
  const fields = STEP_FIELDS[type];
  const properties: Record<string, JsonSchema> = { type: { const: type } };
  for (const field of [...fields.required, ...fields.optional]) {
    const schema = ASSERTION_SCHEMAS[type]?.[field] ?? STEP_FIELD_SCHEMAS[field];
    if (field !== 'type' && schema !== undefined) properties[field] = schema;
  }
  return closedObject(properties, fields.required);
}

const LOCATOR_FIELD_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  role: { enum: [...ROLES] },
  name: text(1),
  label: text(1),
  text: text(1),
  testId: text(1, MAXIMUM_TEST_ID_LENGTH),
};

function locatorSchema(kind: (typeof LOCATOR_KINDS)[number]): JsonSchema {
  const properties: Record<string, JsonSchema> = { by: { const: kind } };
  for (const field of LOCATOR_FIELDS[kind]) {
    const schema = LOCATOR_FIELD_SCHEMAS[field];
    if (schema !== undefined) properties[field] = schema;
  }
  return closedObject(properties, LOCATOR_FIELDS[kind]);
}

// Builds the schema. The same bytes every time: nothing in it depends on the clock or the machine.
export function planJsonSchema(): JsonSchema {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: schemaId('plan', 1),
    title: `Plan language ${CURRENT_PLAN_VERSION}`,
    description: 'A closed, versioned test plan. Every assertion names the acceptance criterion it checks. '
      + 'Fitting this schema is necessary, not sufficient: the plan parser also checks the project\'s allow-list, '
      + 'matrix, declared secrets and fixtures, its limits and its text safety rules.',
    ...closedObject({
      version: { const: CURRENT_PLAN_VERSION },
      meta: closedObject({
        featureId: { type: 'string', pattern: FEATURE_ID.source },
        specReference: text(1, MAXIMUM_SPEC_REFERENCE_LENGTH),
        title: text(1, MAXIMUM_TITLE_LENGTH),
      }, META_FIELDS),
      targets: { type: 'array', items: { type: 'string', pattern: LOWERCASE_ID.source }, 'minItems': 1, 'uniqueItems': true },
      steps: reference('steps'),
      // Saved browser storage state, by secret name. The JSON itself never appears in a plan.
      storageState: SECRET_REFERENCE,
    }, PLAN_FIELDS),
    $defs: {
      steps: { type: 'array', items: reference('step'), 'minItems': 1 },
      step: { oneOf: STEP_TYPES.map((type) => reference(`${type}Step`)) },
      ...Object.fromEntries(STEP_TYPES.map((type) => [`${type}Step`, stepSchema(type)])),
      locator: { oneOf: LOCATOR_KINDS.map((kind) => locatorSchema(kind)) },
      elementAssertion: {
        oneOf: [
          closedObject({ kind: { enum: [...ELEMENT_STATE_KINDS] } }, ['kind']),
          closedObject({ kind: { enum: [...ELEMENT_TEXT_KINDS] }, value: text(1) }, ['kind', 'value']),
          closedObject({ kind: { const: 'countEquals' }, value: { type: 'integer', minimum: 0, maximum: MAXIMUM_EXPECTED_COUNT } }, ['kind', 'value']),
        ],
      },
      pageAssertion: {
        oneOf: [
          closedObject({ kind: { enum: [...PAGE_TEXT_KINDS] }, value: text(0) }, ['kind', 'value']),
          closedObject({ kind: { const: 'url' }, value: reference('url') }, ['kind', 'value']),
        ],
      },
      // A path starting with "/", or an absolute http or https URL. The parser checks the origin.
      url: { type: 'string', 'minLength': 1, 'maxLength': MAXIMUM_URL_LENGTH, pattern: '^(/|https?://)' },
    },
  };
}
