// The plan language's grammar as data: which fields each step and locator has, and the patterns
// its ids follow. The plan parser reads these tables to decode a plan, and planJsonSchema() reads
// the same tables to build the published JSON Schema, so the two cannot drift apart.
import {
  DOM_CHECK_KINDS, DOWNLOAD_SIZE_KINDS, DOWNLOAD_TEXT_KINDS, ELEMENT_STATE_KINDS, ELEMENT_TEXT_KINDS, SEMANTIC_LOCATOR_KINDS, PAGE_TEXT_KINDS,
  PLAN_VERSION, STRUCTURAL_LOCATOR_KINDS,
  type DatabaseCommandStep, type PageScriptStep, type StepType, type StructuralLocatorKind, type UnsafeFeature,
} from '@revisum/contracts';

// The one version text a plan may declare. Anything else is refused, so no plan partly runs.
export const CURRENT_PLAN_VERSION: `${number}.${number}` = `${PLAN_VERSION.major}.${PLAN_VERSION.minor}`;

// The field every assertion step carries: the acceptance criterion it checks. A missing one makes
// the assertion vacuous rather than merely incomplete, so the parser reports it as such.
export const CRITERION_FIELD = 'criterionId';

// A remember step's source and a relative day's anchor are both written `from`. The name is
// spelt once, here, as a template literal, since the import checks take that word followed by a
// quotation mark for an import.
export const FROM_FIELD = `from`;

type StepFields = { readonly required: readonly string[]; readonly optional: readonly string[] };

// Every step's fields. `type` is always required; no other field is allowed.
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
  // An advance without a mode runs timers.
  advanceClock: { required: ['type', 'by'], optional: ['mode'] },
  expectClipboard: { required: ['type', 'assert', CRITERION_FIELD], optional: [] },
  // The unsafe features' steps: a page script or a database command the project declares.
  evaluate: { required: ['type', 'script', 'arguments'], optional: ['remember'] },
  expectScript: { required: ['type', 'script', 'arguments', 'field', 'assert', CRITERION_FIELD], optional: [] },
  database: { required: ['type', 'command', 'arguments'], optional: ['remember'] },
  expectDatabase: { required: ['type', 'command', 'arguments', 'field', 'assert', CRITERION_FIELD], optional: [] },
};
// Stubs, request checks and web storage, which name what the trusted project declares.
const NETWORK_AND_STORAGE_STEP_TYPES: readonly StepType[] = [
  'stub', 'resetRequests', 'expectRequests', 'expectResponse', 'setStorage', 'removeStorage', 'expectStorage',
];
// Advancing the run's virtual clock and checking the clipboard, which need no declaration.
const CLOCK_AND_CLIPBOARD_STEP_TYPES: readonly StepType[] = ['advanceClock', 'expectClipboard'];
// The unsafe features' steps, which a plan may hold only once its project enables their feature.
export const UNSAFE_STEP_TYPES: readonly StepType[] = ['evaluate', 'expectScript', 'database', 'expectDatabase'];
export const STEP_TYPES: readonly StepType[] = [
  'navigate', 'click', 'hover', 'fill', 'select', 'upload', 'press', 'frame', 'dialog', 'expect', 'expectPage', 'a11yAudit', 'capture',
  'remember', 'download', 'expectDownload', 'newTab', 'call', 'expectBackend', ...NETWORK_AND_STORAGE_STEP_TYPES, ...CLOCK_AND_CLIPBOARD_STEP_TYPES,
  ...UNSAFE_STEP_TYPES,
];
// The steps that check something. A plan needs at least one, or it would pass without proving
// anything. A clock advance checks nothing.
export const ASSERTION_STEP_TYPES: readonly StepType[] = [
  'expect', 'expectPage', 'expectDownload', 'expectBackend', 'expectRequests', 'expectResponse', 'expectStorage', 'expectClipboard',
  'expectScript', 'expectDatabase',
];
// The steps that call a declared service.
const SERVICE_CALL_STEP_TYPES: readonly StepType[] = ['call', 'expectBackend'];
// Steps that set up or check the whole test, not act in a page: only the plan's own list of steps
// may hold them, never a frame or a second tab.
export const TOP_LEVEL_STEP_TYPES: readonly StepType[] = [...SERVICE_CALL_STEP_TYPES, 'database', 'expectDatabase'];
// What a plan's cleanup may hold: calls, and database commands.
export const CLEANUP_STEP_TYPES: readonly StepType[] = ['call', 'database'];

// ---- Which unsafe feature each construct needs --------------------------------------------------
// The one table of what needs which feature: the parser refuses a construct whose feature the
// project leaves off, and unsafeFeaturesOf names a plan's features, both from these.

export const LOCATOR_FEATURES: { readonly [Kind in StructuralLocatorKind]: UnsafeFeature } = { css: 'css-locator', xpath: 'xpath-locator' };
// DOM checks and remembering an attribute.
export const DOM_CHECKS_FEATURE: UnsafeFeature = 'dom-checks';
// A named script needs page-script; an inline one needs inline-page-script, which a project can
// enable only together with page-script.
export const NAMED_SCRIPT_FEATURE: UnsafeFeature = 'page-script';
export const INLINE_SCRIPT_FEATURE: UnsafeFeature = 'inline-page-script';
export const DATABASE_COMMAND_FEATURE: UnsafeFeature = 'database-command';
export const isPageScriptStepType = (type: StepType): type is PageScriptStep['type'] => type === 'evaluate' || type === 'expectScript';
export const isDatabaseCommandStepType = (type: StepType): type is DatabaseCommandStep['type'] => type === 'database' || type === 'expectDatabase';

// The fields of each locator kind, in the order they are written. All are required.
export const LOCATOR_FIELDS = {
  role: ['by', 'role', 'name'],
  label: ['by', 'label'],
  text: ['by', 'text'],
  testId: ['by', 'testId'],
  css: ['by', 'selector'],
  xpath: ['by', 'expression'],
} as const;
// The fields a locator may add.
export const OPTIONAL_LOCATOR_FIELDS = {
  role: ['position'],
  label: ['position'],
  text: ['position'],
  testId: ['attribute', 'position'],
  css: ['hasText', 'inside', 'position'],
  xpath: ['hasText', 'inside', 'position'],
} as const;
export type LocatorKind = keyof typeof LOCATOR_FIELDS;
// Every locator kind.
export const ALL_LOCATOR_KINDS: readonly LocatorKind[] = [...SEMANTIC_LOCATOR_KINDS, ...STRUCTURAL_LOCATOR_KINDS];
// How many `inside` links a css or XPath locator may chain: the fourth is refused.
export const MAXIMUM_INSIDE_DEPTH = 3;
// A css selector or XPath expression: literal plan text of at most this many characters, on one
// line, with none of the characters below. "{", "}" and ";" would open declarations or rules, and
// "@" at-rules or XPath attribute steps.
export const MAXIMUM_SELECTOR_LENGTH = 512;
export const SELECTOR_FORBIDDEN_CHARACTERS = /[{};@]/;

export const PLAN_FIELDS = ['version', 'meta', 'targets', 'steps'] as const;
// Top-level fields a plan may leave out: storageState names saved browser storage state, values
// names the values generated for each run, clock sets the page's frozen clock, and cleanup lists
// the calls that run after the steps, whatever the outcome.
export const OPTIONAL_PLAN_FIELDS = ['storageState', 'values', 'clock', 'cleanup'] as const;
export const META_FIELDS = ['featureId', 'specReference', 'title'] as const;
export const PAGE_KINDS = [...PAGE_TEXT_KINDS, 'url', 'urlPathStartsWith', 'metaContent', 'canonicalUrl'] as const;
export const ELEMENT_KINDS = [...ELEMENT_STATE_KINDS, ...ELEMENT_TEXT_KINDS, 'countEquals', 'hrefEquals', ...DOM_CHECK_KINDS] as const;
export const DOWNLOAD_KINDS = [...DOWNLOAD_TEXT_KINDS, 'mediaTypeEquals', ...DOWNLOAD_SIZE_KINDS] as const;

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
// A query key in a path template. "__proto__" is never one: a key that means something else to
// whatever reads the plan next could not mean one thing everywhere.
export const QUERY_KEY = /^(?!__proto__$)[A-Za-z0-9_.-]{1,64}$/;
// A plan clock's time of day, "HH:MM" on the 24-hour clock.
export const CLOCK_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
// The start of a generated email address: characters every mail system accepts in a local part.
export const EMAIL_LOCAL_PREFIX = /^[A-Za-z0-9._+-]{1,53}$/;

// How a URL in a plan is written: a path starting with "/", or an absolute http or https URL in
// lower case. A URL parser would also forgive other spellings, such as a leading space.
export const WRITTEN_URL_PATTERN = '^(/|https?://)';
export const WRITTEN_URL = new RegExp(WRITTEN_URL_PATTERN);

// The characters plan and project text may not hold, as regular expression source for a character
// class: C0 and C1 controls, and characters that hide or change what the text reads as (zero width
// space, directional marks and overrides, word joiners and other invisible operators, byte order
// mark, interlinear annotation marks) or break the line where nothing shows (U+2028, U+2029). The
// zero width non-joiner and joiner (U+200C, U+200D) stay allowed, because emoji and Persian and
// Indic text need them, and so does the soft hyphen, because pages hold it and a plan may quote them.
export const UNSAFE_TEXT_CHARACTERS = '\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u180e\\u200b\\u200e\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff\\ufff9-\\ufffb';

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

// ---- Unsafe features ------------------------------------------------------------------------------

// One class token, as hasClass and lacksClass name it: no white space, so it cannot be two classes.
export const CLASS_TOKEN = /^[^\s]{1,256}$/;
// A lowercase css property name, such as "background-color" or "-webkit-line-clamp".
export const STYLE_PROPERTY = /^-?[a-z][a-z0-9-]{0,99}$/;
// An attribute name: lowercase letters, digits and hyphens, starting with a letter.
export const ATTRIBUTE_NAME = /^[a-z][a-z0-9-]{0,99}$/;
// The longest a class token, style property or attribute name may be: the longest of their patterns.
export const MAXIMUM_LITERAL_NAME_LENGTH = 256;
// The longest expected text a computed style check may compare against.
export const MAXIMUM_STYLE_VALUE_LENGTH = 500;
// The longest script text a plan may hold inline.
export const MAXIMUM_INLINE_SCRIPT_LENGTH = 4000;
