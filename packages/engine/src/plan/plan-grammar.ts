// The plan language's grammar as data: which fields each step and locator has, and the patterns
// its ids follow. The plan parser reads these tables to decode a plan, and planJsonSchema() reads
// the same tables to build the published JSON Schema, so the two cannot drift apart.
// See docs/specs/SPEC-01-plan-language-and-parser.md, docs/specs/SPEC-30-plan-values-positions-and-keys.md
// and docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import {
  DOWNLOAD_SIZE_KINDS, DOWNLOAD_TEXT_KINDS, ELEMENT_STATE_KINDS, ELEMENT_TEXT_KINDS, KEYS, PAGE_TEXT_KINDS, PLAN_VERSION,
  type Key, type StepType,
} from '@revisum/contracts';

// The version text a current plan declares, such as "1.2".
export const CURRENT_PLAN_VERSION: `${number}.${number}` = `${PLAN_VERSION.major}.${PLAN_VERSION.minor}`;
// The version before it, whose plans still parse exactly as they always did.
export const PREVIOUS_PLAN_VERSION = '1.1';

// The field every assertion step carries: the acceptance criterion it checks. A missing one makes
// the assertion vacuous rather than merely incomplete, so the parser reports it as such.
export const CRITERION_FIELD = 'criterionId';

// A remember step's source and a relative day's anchor are both written `from`. The name is
// spelt once, here, as a template literal, since the import checks take that word followed by a
// quotation mark for an import.
export const FROM_FIELD = `from`;

export type StepFields = { readonly required: readonly string[]; readonly optional: readonly string[] };

// Every step's fields in the current language. `type` is always required; no other field is allowed.
export const STEP_FIELDS: { readonly [Type in StepType]: StepFields } = {
  navigate: { required: ['type', 'url'], optional: ['scripts'] },
  click: { required: ['type', 'locator'], optional: [] },
  download: { required: ['type', 'name', 'locator'], optional: [] },
  hover: { required: ['type', 'locator'], optional: [] },
  fill: { required: ['type', 'locator', 'value'], optional: [] },
  select: { required: ['type', 'locator', 'option'], optional: [] },
  upload: { required: ['type', 'locator', 'fixture'], optional: [] },
  press: { required: ['type', 'locator', 'key'], optional: ['modifiers'] },
  frame: { required: ['type', 'locator', 'steps'], optional: [] },
  dialog: { required: ['type', 'action'], optional: ['expectText'] },
  expect: { required: ['type', 'locator', 'assert', CRITERION_FIELD], optional: [] },
  expectPage: { required: ['type', 'assert', CRITERION_FIELD], optional: [] },
  expectDownload: { required: ['type', 'download', 'assert', CRITERION_FIELD], optional: [] },
  newTab: { required: ['type', 'url', 'steps'], optional: [] },
  a11yAudit: { required: ['type', 'mode'], optional: [] },
  capture: { required: ['type', 'name'], optional: [] },
  remember: { required: ['type', 'name', FROM_FIELD], optional: [] },
  call: { required: ['type', 'call', 'arguments'], optional: ['remember'] },
  expectBackend: { required: ['type', 'call', 'arguments', 'field', 'assert', CRITERION_FIELD], optional: [] },
  // Arguments only with a start; the parser refuses them on a stop.
  stub: { required: ['type', 'stub', 'action'], optional: ['arguments'] },
  resetRequests: { required: ['type', 'request'], optional: [] },
  expectRequests: { required: ['type', 'request', 'count', CRITERION_FIELD], optional: [] },
  expectResponse: { required: ['type', 'request', 'assert', CRITERION_FIELD], optional: [] },
  setStorage: { required: ['type', 'entry'], optional: ['arguments'] },
  removeStorage: { required: ['type', 'entry'], optional: [] },
  expectStorage: { required: ['type', 'entry', 'assert', CRITERION_FIELD], optional: [] },
};
// Stubs, request checks and web storage, which name what the trusted project declares.
const NETWORK_AND_STORAGE_STEP_TYPES: readonly StepType[] = [
  'stub', 'resetRequests', 'expectRequests', 'expectResponse', 'setStorage', 'removeStorage', 'expectStorage',
];
export const STEP_TYPES: readonly StepType[] = [
  'navigate', 'click', 'hover', 'fill', 'select', 'upload', 'press', 'frame', 'dialog', 'expect', 'expectPage', 'a11yAudit', 'capture',
  'remember', 'download', 'expectDownload', 'newTab', 'call', 'expectBackend', ...NETWORK_AND_STORAGE_STEP_TYPES,
];
// The steps language 1.2 added, which a plan declaring "1.1" cannot use.
const NEWER_STEP_TYPES: readonly StepType[] = [
  'remember', 'download', 'expectDownload', 'newTab', 'call', 'expectBackend', ...NETWORK_AND_STORAGE_STEP_TYPES,
];
// The steps that check something. A plan needs at least one, or it would pass without proving anything.
export const ASSERTION_STEP_TYPES: readonly StepType[] = [
  'expect', 'expectPage', 'expectDownload', 'expectBackend', 'expectRequests', 'expectResponse', 'expectStorage',
];
// The steps that call a declared service. Only the plan's own list of steps may hold them, and a
// plan's cleanup holds nothing else but calls.
export const SERVICE_CALL_STEP_TYPES: readonly StepType[] = ['call', 'expectBackend'];
export const CLEANUP_STEP_TYPES: readonly StepType[] = ['call'];

// The fields of each locator kind, in the order they are written. All are required.
export const LOCATOR_FIELDS = {
  role: ['by', 'role', 'name'],
  label: ['by', 'label'],
  text: ['by', 'text'],
  testId: ['by', 'testId'],
} as const;
// The fields a locator may add in the current language.
export const OPTIONAL_LOCATOR_FIELDS = {
  role: ['position'],
  label: ['position'],
  text: ['position'],
  testId: ['attribute', 'position'],
} as const;

export const PLAN_FIELDS = ['version', 'meta', 'targets', 'steps'] as const;
// Top-level fields a plan may leave out: storageState names saved browser storage state, values
// names the values generated for each run, clock sets the page's frozen clock, and cleanup lists
// the calls that run after the steps, whatever the outcome.
export const OPTIONAL_PLAN_FIELDS = ['storageState', 'values', 'clock', 'cleanup'] as const;
export const META_FIELDS = ['featureId', 'specReference', 'title'] as const;
export const PAGE_KINDS = [...PAGE_TEXT_KINDS, 'url', 'urlPathStartsWith', 'metaContent', 'canonicalUrl'] as const;
export const ELEMENT_KINDS = [...ELEMENT_STATE_KINDS, ...ELEMENT_TEXT_KINDS, 'countEquals', 'hrefEquals'] as const;
export const DOWNLOAD_KINDS = [...DOWNLOAD_TEXT_KINDS, 'mediaTypeEquals', ...DOWNLOAD_SIZE_KINDS] as const;
// The 8 state checks of language 1.1 lead the list of state checks.
const PREVIOUS_STATE_COUNT = 8;

// What one language version allows. Version 1.1 is a subset of 1.2: a plan declaring "1.1" is
// read with everything 1.2 added switched off, so it is accepted or refused exactly as a 1.1
// parser would, with the same codes and paths.
export type Grammar = {
  readonly version: `${number}.${number}`;
  readonly stepTypes: readonly StepType[];
  readonly stepFields: { readonly [Type in StepType]: StepFields };
  readonly optionalLocatorFields: { readonly [Kind in keyof typeof LOCATOR_FIELDS]: readonly string[] };
  readonly optionalPlanFields: readonly string[];
  readonly keys: readonly Key[];
  readonly elementKinds: readonly string[];
  readonly pageKinds: readonly string[];
  // Value references, multi-line fills and path templates: the object forms text may take.
  readonly runValues: boolean;
};

// The 14 keys of language 1.1 lead the list of keys.
const PREVIOUS_KEY_COUNT = 14;

export const CURRENT_GRAMMAR: Grammar = {
  version: CURRENT_PLAN_VERSION,
  stepTypes: STEP_TYPES,
  stepFields: STEP_FIELDS,
  optionalLocatorFields: OPTIONAL_LOCATOR_FIELDS,
  optionalPlanFields: OPTIONAL_PLAN_FIELDS,
  keys: KEYS,
  elementKinds: ELEMENT_KINDS,
  pageKinds: PAGE_KINDS,
  runValues: true,
};

export const PREVIOUS_GRAMMAR: Grammar = {
  version: PREVIOUS_PLAN_VERSION,
  stepTypes: STEP_TYPES.filter((type) => !NEWER_STEP_TYPES.includes(type)),
  stepFields: {
    ...STEP_FIELDS,
    navigate: { required: STEP_FIELDS.navigate.required, optional: [] },
    press: { required: STEP_FIELDS.press.required, optional: [] },
  },
  optionalLocatorFields: { role: [], label: [], text: [], testId: [] },
  optionalPlanFields: ['storageState'],
  keys: KEYS.slice(0, PREVIOUS_KEY_COUNT),
  elementKinds: [...ELEMENT_STATE_KINDS.slice(0, PREVIOUS_STATE_COUNT), ...ELEMENT_TEXT_KINDS, 'countEquals'],
  pageKinds: [...PAGE_TEXT_KINDS, 'url'],
  runValues: false,
};

// The grammar for the version a plan declares, or undefined for a version this engine does not read.
export const grammarFor = (version: unknown): Grammar | undefined =>
  [CURRENT_GRAMMAR, PREVIOUS_GRAMMAR].find((grammar) => grammar.version === version);

export const FEATURE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const CAPTURE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
// A download's name, such as "project-list": the plan's handle on the file, never a file name.
export const DOWNLOAD_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const CRITERION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
// A lowercase id such as a target id; the project parser owns ids and applies the same rule.
export const LOWERCASE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
// A run value's name: a lowercase letter, then up to 63 letters and digits.
export const VALUE_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
// A declared call's, parameter's, response field's, stub's, observed request's or storage entry's
// name: a lowercase letter, then up to 63 letters and digits. The project parser owns these names;
// a plan only refers to them.
export const DECLARED_NAME = /^[a-z][A-Za-z0-9]{0,63}$/;
// A query key in a path template.
export const QUERY_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
// A plan clock's time of day, "HH:MM" on the 24-hour clock.
export const CLOCK_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
// The start of a generated email address: characters every mail system accepts in a local part.
export const EMAIL_LOCAL_PREFIX = /^[A-Za-z0-9._+-]{1,53}$/;

// Fixed text lengths that do not depend on the project's limits.
export const MAXIMUM_URL_LENGTH = 2048;
export const MAXIMUM_TEST_ID_LENGTH = 64;
export const MAXIMUM_SPEC_REFERENCE_LENGTH = 200;
export const MAXIMUM_TITLE_LENGTH = 120;
// The prefix of a generated unique text.
export const MAXIMUM_VALUE_PREFIX_LENGTH = 100;
// The largest number a countEquals assertion or a request count may expect.
export const MAXIMUM_EXPECTED_COUNT = 10_000;
// The statuses a response check may expect: any a browser's fetch can receive.
export const RESPONSE_STATUS = { lowest: 100, highest: 599 } as const;
// The highest 1-based position a locator may pick.
export const MAXIMUM_POSITION = 1000;
// How many days a date value or the plan clock may lie from its anchor, either way.
export const MAXIMUM_DAY_OFFSET = 3660;
// The digits of a generated unique number.
export const UNIQUE_NUMBER_DIGITS = { fewest: 4, most: 12 } as const;
// How many modifiers a press may hold down.
export const MAXIMUM_MODIFIERS = 4;
// How many values a plan may generate, segments a path template may have and query values it may set.
export const MAXIMUM_VALUES = 64;
export const MAXIMUM_PATH_SEGMENTS = 32;
export const MAXIMUM_QUERY_VALUES = 32;
// The largest download a project may allow, and so the largest size a download check may name: 100 MiB.
export const LARGEST_DOWNLOAD_BYTES = 100 * 1024 * 1024;
// The name or property of a meta tag, such as "og:title".
export const MAXIMUM_META_NAME_LENGTH = 128;
