// The plan language's grammar as data: which fields each step and locator has, and the patterns
// its ids follow. The plan parser reads these tables to decode a plan, and planJsonSchema() reads
// the same tables to build the published JSON Schema, so the two cannot drift apart.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import { PLAN_VERSION, type StepType } from '@revisum/contracts';

// The version text a current plan declares, such as "1.1".
export const CURRENT_PLAN_VERSION: `${number}.${number}` = `${PLAN_VERSION.major}.${PLAN_VERSION.minor}`;

// The field every assertion step carries: the acceptance criterion it checks. A missing one makes
// the assertion vacuous rather than merely incomplete, so the parser reports it as such.
export const CRITERION_FIELD = 'criterionId';

export type StepFields = { readonly required: readonly string[]; readonly optional: readonly string[] };

// Every step's fields. `type` is always required; no other field is allowed.
export const STEP_FIELDS: { readonly [Type in StepType]: StepFields } = {
  navigate: { required: ['type', 'url'], optional: [] },
  click: { required: ['type', 'locator'], optional: [] },
  hover: { required: ['type', 'locator'], optional: [] },
  fill: { required: ['type', 'locator', 'value'], optional: [] },
  select: { required: ['type', 'locator', 'option'], optional: [] },
  upload: { required: ['type', 'locator', 'fixture'], optional: [] },
  press: { required: ['type', 'locator', 'key'], optional: [] },
  frame: { required: ['type', 'locator', 'steps'], optional: [] },
  dialog: { required: ['type', 'action'], optional: ['expectText'] },
  expect: { required: ['type', 'locator', 'assert', CRITERION_FIELD], optional: [] },
  expectPage: { required: ['type', 'assert', CRITERION_FIELD], optional: [] },
  a11yAudit: { required: ['type', 'mode'], optional: [] },
  capture: { required: ['type', 'name'], optional: [] },
};
export const STEP_TYPES: readonly StepType[] = [
  'navigate', 'click', 'hover', 'fill', 'select', 'upload', 'press', 'frame', 'dialog', 'expect', 'expectPage', 'a11yAudit', 'capture',
];
// The steps that check something. A plan needs at least one, or it would pass without proving anything.
export const ASSERTION_STEP_TYPES: readonly StepType[] = ['expect', 'expectPage'];

// The fields of each locator kind, in the order they are written.
export const LOCATOR_FIELDS = {
  role: ['by', 'role', 'name'],
  label: ['by', 'label'],
  text: ['by', 'text'],
  testId: ['by', 'testId'],
} as const;

export const PLAN_FIELDS = ['version', 'meta', 'targets', 'steps'] as const;
// Top-level fields a plan may leave out. storageState names saved browser storage state.
export const OPTIONAL_PLAN_FIELDS = ['storageState'] as const;
export const META_FIELDS = ['featureId', 'specReference', 'title'] as const;

export const FEATURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CAPTURE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const CRITERION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// A lowercase id such as a target id; the project parser owns ids and applies the same rule.
export const LOWERCASE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

// Fixed text lengths that do not depend on the project's limits.
export const MAXIMUM_URL_LENGTH = 2048;
export const MAXIMUM_TEST_ID_LENGTH = 64;
export const MAXIMUM_SPEC_REFERENCE_LENGTH = 200;
export const MAXIMUM_TITLE_LENGTH = 120;
// The largest number a countEquals assertion may expect.
export const MAXIMUM_EXPECTED_COUNT = 10_000;
