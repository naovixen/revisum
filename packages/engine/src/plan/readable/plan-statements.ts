// The readable plan grammar: one statement form for every step, check, locator, value and header of
// the plan language, each built from the two-way syntax pieces of text-syntax.ts, so the same
// description reads text into plain JSON and writes a plan's JSON back as text.
//
// The forms only turn words into JSON fields. They never decide what is allowed: a name, number,
// URL or reference is copied as it is, and the one plan parser checks it. The word lists come from
// the language's own tables (roles, keys, states, units, formats), and each table of forms is typed
// by the union it covers, so a step, check or value kind added to the language without a readable
// form fails to compile.
// See docs/specs/SPEC-28-plan-authoring.md ("Readable syntax for plan 1.2").
import {
  AUDIT_MODES, CLIPBOARD_READS, CLOCK_UNITS, ELEMENT_STATE_KINDS, KEYS, MODIFIERS, POSITION_WORDS, REMEMBER_READS, ROLES,
  type BackendAssertion, type ClipboardAssertion, type ClockAdvanceMode, type DateAnchor, type DateFormat, type DIALOG_ACTIONS,
  type DownloadAssertion, type ElementAssertion, type GeneratedValue, type Locator, type PageAssertion, type REQUEST_COUNT_KINDS,
  type ResponseAssertion, type ResponseRead, type SCRIPT_MODES, type StepType, type StorageAssertion,
} from '@revisum/contracts';
import { FROM_FIELD, STEP_TYPES } from '../plan-grammar.ts';
import {
  BARE, DIGITS, END, NO_READABLE_FORM, NUMBER, QUOTED, REFERENCE, URL_WORD,
  better, choice, constant, countedWord, either, entry, field, group, isRecord, list, map, notThisStatement, oneOf, optional, orElse,
  phrases, record, reportedAs, skipSpaces, unitOf, wordAt, words, wordsFor,
  type EntrySyntax, type RecordPart, type Syntax,
} from './text-syntax.ts';

// One record form per value of the discriminating field `key`, each led by `leading` parts.
function variants(key: string, forms: Readonly<Record<string, readonly RecordPart[]>>, leading: readonly RecordPart[] = []): Syntax {
  return choice(...Object.entries(forms).map(([value, parts]) => record([...leading, constant(key, value), ...parts])));
}

// ---- Text, numbers and names ---------------------------------------------------------------------

// Page-facing text: quoted text, or a reference to a run value. The parser decides where a
// reference may stand.
export const TEXT = choice(QUOTED, REFERENCE);

// Several lines of text, as a multi-line fill or an expected clipboard text.
const LINES = record([words('lines'), field('lines', list(TEXT))]);

// Header text, for Plan: and Spec:, is the rest of the line as it stands. Text that starts or ends
// with white space, or starts with a quote, is written quoted instead, so it reads back exactly.
export const HEADER_TEXT: Syntax = {
  read(line, index) {
    const start = skipSpaces(line, index);
    if (line[start] === '"') return QUOTED.read(line, start);
    return { ok: true, value: line.slice(start), next: line.length, furthest: undefined };
  },
  write(value) {
    if (typeof value !== 'string') return undefined;
    return value === '' || /^\s|\s$/u.test(value) || value.startsWith('"') ? QUOTED.write(value) : value;
  },
};

const BOOLEAN = phrases([[true, 'true'], [false, 'false']]);

// ---- Locators -------------------------------------------------------------------------------------

// The English ordinal suffix of a whole number: 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st.
function ordinalSuffix(position: number): string {
  const lastTwo = position % 100;
  if (lastTwo >= 11 && lastTwo <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][position % 10] ?? 'th';
}

// "first" and "last" are the position words; "1st", "2nd" and so on are positions by number.
const POSITION_WORD = oneOf(POSITION_WORDS);
const POSITION: Syntax = {
  read(line, index) {
    const named = POSITION_WORD.read(line, index);
    if (named.ok) return named;
    const { word, start, end } = wordAt(line, index);
    const ordinal = /^([0-9]+)([A-Za-z]+)$/.exec(word);
    if (ordinal === null) return { ok: false, failure: notThisStatement(start) };
    const position = Number(ordinal[1]);
    if ((ordinal[2] ?? '').toLowerCase() !== ordinalSuffix(position)) return { ok: false, failure: { code: 'bad-locator', column: start + 1, reach: start } };
    return { ok: true, value: position, next: end, furthest: undefined };
  },
  write(value) {
    if (typeof value === 'string') return POSITION_WORD.write(value);
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? `${value}${ordinalSuffix(value)}` : undefined;
  },
};

const LOCATOR_FORMS: { readonly [Kind in Locator['by']]: readonly RecordPart[] } = {
  role: [field('role', oneOf(ROLES)), field('name', TEXT)],
  label: [words('label'), field('label', TEXT)],
  text: [words('text'), field('text', TEXT)],
  testId: [words('test id'), field('testId', TEXT), optional(words('in attribute'), field('attribute', BARE))],
  // CSS and XPath locators are unsafe plan features, written in JSON until the readable format
  // gives them a form (docs/specs/SPEC-36-unsafe-plan-features.md).
  css: [NO_READABLE_FORM],
  xpath: [NO_READABLE_FORM],
};
// Any locator that cannot be read is bad-locator, at the locator.
export const LOCATOR = reportedAs('bad-locator', variants('by', LOCATOR_FORMS, [optional(field('position', POSITION))]));

// ---- Keys -----------------------------------------------------------------------------------------

// A key with the modifiers held while it is pressed, in the order held: "Control+Shift+Backquote".
// Without a modifier the step has no modifiers field. A name the language does not have is
// unknown-key-name, at that name.
const KEY_CHORD: RecordPart = {
  keys: ['key', 'modifiers'],
  read(line, index, into) {
    const { word, start, end } = wordAt(line, index);
    const names = word.split('+');
    const modifiers: string[] = [];
    let column = start + 1;
    for (const [place, name] of names.entries()) {
      const isKey = place === names.length - 1;
      const found = (isKey ? KEYS : MODIFIERS).find((candidate: string) => candidate.toLowerCase() === name.toLowerCase());
      if (found === undefined) return { ok: false, failure: { code: 'unknown-key-name', column, reach: start } };
      if (isKey) into['key'] = found;
      else modifiers.push(found);
      column += name.length + 1;
    }
    if (modifiers.length > 0) into['modifiers'] = modifiers;
    return { ok: true, value: null, next: end, furthest: undefined };
  },
  write(fields) {
    const key = KEYS.find((candidate) => candidate === fields['key']);
    const modifiers = fields['modifiers'] ?? [];
    if (key === undefined || !Array.isArray(modifiers)) return undefined;
    if (Object.hasOwn(fields, 'modifiers') && modifiers.length === 0) return undefined;
    const held = modifiers.map((modifier) => MODIFIERS.find((candidate) => candidate === modifier));
    return held.every((modifier) => modifier !== undefined) ? [...held, key].join('+') : undefined;
  },
};

// ---- Days and run values ------------------------------------------------------------------------------

const DATE_ANCHOR_WORDS: { readonly [Anchor in DateAnchor]: string } = {
  today: 'today', startOfWeek: 'start of week', startOfMonth: 'start of month', startOfNextMonth: 'start of next month',
};
const DATE_FORMAT_WORDS: { readonly [Format in DateFormat]: string } = {
  yearMonthDay: 'year-month-day', dayOfMonth: 'day of month', monthAndYear: 'month and year', longDate: 'long date',
  weekday: 'weekday', timestamp: 'timestamp', epochMilliseconds: 'epoch milliseconds',
};
const ANCHOR = wordsFor(DATE_ANCHOR_WORDS);
// "3 days after today": the count, then the direction and the anchor.
const SHIFTED_DAY = record([
  field('days', DIGITS), countedWord('days', 'day', 'days'), field('direction', oneOf(['after', 'before'])), field('anchor', ANCHOR),
]);

// A day relative to an anchor. The writer writes addDays 0 as the anchor alone, 1 as "1 day after"
// and others as "<n> days after" or "<n> days before".
const DAY: Syntax = {
  read(line, index) {
    const anchorAlone = ANCHOR.read(line, index);
    if (anchorAlone.ok) return { ...anchorAlone, value: { [FROM_FIELD]: anchorAlone.value, addDays: 0 } };
    const shifted = SHIFTED_DAY.read(line, index);
    if (!shifted.ok) return { ok: false, failure: better(anchorAlone.failure, shifted.failure) ?? shifted.failure };
    const parts = isRecord(shifted.value) ? shifted.value : {};
    const days = typeof parts['days'] === 'number' ? parts['days'] : 0;
    const addDays = days === 0 ? 0 : parts['direction'] === 'after' ? days : -days;
    return { ...shifted, value: { [FROM_FIELD]: parts['anchor'], addDays } };
  },
  write(value) {
    if (!isRecord(value) || Object.keys(value).length !== 2) return undefined;
    const addDays = value['addDays'];
    if (typeof addDays !== 'number' || !Number.isSafeInteger(addDays)) return undefined;
    if (addDays === 0) return ANCHOR.write(value[FROM_FIELD]);
    return SHIFTED_DAY.write({ days: Math.abs(addDays), direction: addDays > 0 ? 'after' : 'before', anchor: value[FROM_FIELD] });
  },
};

const GENERATED_VALUE_FORMS: { readonly [Kind in GeneratedValue['kind']]: readonly RecordPart[] } = {
  uniqueText: [words('unique text starting'), field('prefix', TEXT)],
  // Without "at", the domain is left out and the run uses the project's first declared one.
  uniqueEmail: [words('unique email starting'), field('localPrefix', TEXT), optional(words('at'), field('domain', BARE))],
  uniqueNumber: [words('unique number of'), field('digits', NUMBER), words('digits')],
  date: [words('date'), field('day', DAY), words('as'), field('format', wordsFor(DATE_FORMAT_WORDS))],
};
// One line under Values:, such as `displayName is unique text starting "Tester"`.
export const VALUE_DEFINITION: EntrySyntax = entry(['name', words('is'), 'value', END], variants('kind', GENERATED_VALUE_FORMS));

// ---- Arguments, queries and remembered fields ---------------------------------------------------------

// An argument: text, a number, true or false, or a secret by name.
const SECRET = record([words('secret'), field('secretName', BARE)]);
const ARGUMENT = choice(SECRET, TEXT, NUMBER, BOOLEAN);
// "<parameter> <argument>, …". A list ends at a word that cannot be a value, so a parameter named
// after a grammar word is still read correctly. The writer keeps the declaration's order.
const ARGUMENTS = map(entry(['name', 'value'], ARGUMENT));
// A call's arguments are {} when "with" is left out.
const CALL_ARGUMENTS = orElse('arguments', {}, words('with'), field('arguments', ARGUMENTS));
// A stub start or a storage write may leave its arguments out, or give none.
const OPTIONAL_ARGUMENTS = optional(either(
  group([words('with no arguments'), constant('arguments', {})]),
  group([words('with'), field('arguments', ARGUMENTS)]),
));
// "remembering field <field> as <name>, …" or "remembering nothing", in the JSON order.
const REMEMBERING = optional(either(
  group([words('remembering nothing'), constant('remember', {})]),
  group([words('remembering'), field('remember', map(entry([words('field'), 'value', words('as'), 'name'], BARE)))]),
));

// A path template: `path "orders" / {orderCode}`, and its query values or an empty query.
const PATH_TEMPLATE = record([
  words('path'), field('segments', list(TEXT, '/')),
  optional(either(
    group([words('with empty query'), constant('query', {})]),
    group([words('with query'), field('query', map(entry(['name', 'value'], TEXT)))]),
  )),
]);
// Where a navigate step or a second tab goes: a URL or path as written, or a path template.
const NAVIGATION = choice(PATH_TEMPLATE, URL_WORD);

// ---- Checks -----------------------------------------------------------------------------------------

type ElementStateKind = (typeof ELEMENT_STATE_KINDS)[number];
const ELEMENT_CHECK_FORMS: { readonly [Kind in Exclude<ElementAssertion['kind'], ElementStateKind>]: readonly RecordPart[] } = {
  textEquals: [words('has text'), field('value', TEXT)],
  textContains: [words('has text containing'), field('value', TEXT)],
  valueEquals: [words('has value'), field('value', TEXT)],
  valueContains: [words('has value containing'), field('value', TEXT)],
  countEquals: [words('count is'), field('value', NUMBER)],
  hrefEquals: [words('links to'), field('value', TEXT)],
  // DOM checks are an unsafe plan feature, written in JSON until the readable format gives them a form.
  hasClass: [NO_READABLE_FORM],
  lacksClass: [NO_READABLE_FORM],
  computedStyleEquals: [NO_READABLE_FORM],
  attributeEquals: [NO_READABLE_FORM],
  attributeAbsent: [NO_READABLE_FORM],
};
// "is visible", "has text containing …" and the other checks after an element's locator.
const ELEMENT_ASSERTION = choice(record([words('is'), field('kind', oneOf(ELEMENT_STATE_KINDS))]), variants('kind', ELEMENT_CHECK_FORMS));

const PAGE_CHECK_FORMS: { readonly [Kind in PageAssertion['kind']]: readonly RecordPart[] } = {
  title: [words('title is'), field('value', TEXT)],
  urlPath: [words('path is'), field('value', TEXT)],
  url: [words('URL is'), field('value', TEXT)],
  urlPathStartsWith: [words('path starts with'), field('value', TEXT)],
  metaContent: [words('meta'), field('name', TEXT), words('is'), field('value', TEXT)],
  canonicalUrl: [words('canonical URL is'), field('value', TEXT)],
};

const DOWNLOAD_CHECK_FORMS: { readonly [Kind in DownloadAssertion['kind']]: readonly RecordPart[] } = {
  fileNameEquals: [words('file name is'), field('value', TEXT)],
  contentContains: [words('contains'), field('value', TEXT)],
  contentExcludes: [words('does not contain'), field('value', TEXT)],
  mediaTypeEquals: [words('media type is'), field('value', TEXT)],
  sizeAtMost: [words('size is at most'), field('value', NUMBER), countedWord('value', 'byte', 'bytes')],
  sizeAtLeast: [words('size is at least'), field('value', NUMBER), countedWord('value', 'byte', 'bytes')],
};

const BACKEND_CHECK_FORMS: { readonly [Kind in BackendAssertion['kind']]: readonly RecordPart[] } = {
  present: [words('is present')],
  absent: [words('is absent')],
  equals: [words('is'), field('value', TEXT)],
  contains: [words('contains'), field('value', TEXT)],
  numberEquals: [words('is number'), field('value', NUMBER)],
};

const RESPONSE_CHECK_FORMS: { readonly [Kind in ResponseAssertion['kind']]: readonly RecordPart[] } = {
  statusEquals: [words('status is'), field('value', NUMBER)],
  fieldPresent: [words('field'), field('field', BARE), words('is present')],
  fieldAbsent: [words('field'), field('field', BARE), words('is absent')],
  fieldEquals: [words('field'), field('field', BARE), words('is'), field('value', TEXT)],
  fieldContains: [words('field'), field('field', BARE), words('contains'), field('value', TEXT)],
};

const STORAGE_CHECK_FORMS: { readonly [Kind in StorageAssertion['kind']]: readonly RecordPart[] } = {
  present: [words('is present')],
  absent: [words('is absent')],
  equals: [words('is'), field('value', TEXT)],
};

const CLIPBOARD_CHECK_FORMS: { readonly [Kind in ClipboardAssertion['kind']]: readonly RecordPart[] } = {
  textEquals: [words('text is'), field('value', choice(LINES, TEXT))],
  textContains: [words('contains'), field('value', TEXT)],
  textExcludes: [words('does not contain'), field('value', TEXT)],
};

// "count is 1", "count is at least 1" or "count is at most 2".
const REQUEST_COUNT_WORDS: { readonly [Kind in (typeof REQUEST_COUNT_KINDS)[number]]: string } = { equals: '', atLeast: 'at least', atMost: 'at most' };
const REQUEST_COUNT = choice(...Object.entries(REQUEST_COUNT_WORDS).map(([kind, phrase]) =>
  record([...(phrase === '' ? [] : [words(phrase)]), field(kind, NUMBER)])));

// ---- Steps ------------------------------------------------------------------------------------------

const RESPONSE_READ_WORDS: { readonly [Read in ResponseRead]: string } = { text: 'text', arrayLength: 'length' };
// Where a remember step reads: the clipboard, a field of a response, or an element's text or value.
// Remembering an attribute is a DOM check, an unsafe plan feature with no readable form yet.
const REMEMBER_SOURCE = choice(
  record([words('clipboard'), field('clipboard', oneOf(CLIPBOARD_READS))]),
  record([field('read', wordsFor(RESPONSE_READ_WORDS)), words('of field'), field('field', BARE), words('in response'), field('response', BARE)]),
  record([field('read', oneOf(REMEMBER_READS)), words('of'), field('element', LOCATOR)]),
);

const SCRIPT_MODE_WORDS: { readonly [Mode in (typeof SCRIPT_MODES)[number]]: string } = { disabled: 'without scripts' };
const CLOCK_MODE_WORDS: { readonly [Mode in ClockAdvanceMode]: string } = { runTimers: 'running timers', skipAhead: 'skipping ahead' };
const DIALOG_ACTION_WORDS: { readonly [Action in (typeof DIALOG_ACTIONS)[number]]: string } = { accept: 'Accept', dismiss: 'Dismiss' };
// "599 seconds", "1 second": the unit is singular for 1.
const CLOCK_ADVANCE = record([field('amount', NUMBER), unitOf('unit', 'amount', CLOCK_UNITS)]);

// Every step's statement forms, without the fields the document around it supplies: a check's
// criterionId comes from the Criterion: line before it, and a frame's or tab's steps from the
// indented block after it. Every check starts with "Expect", and only checks do.
const STEP_FORMS: { readonly [Type in StepType]: readonly (readonly RecordPart[])[] } = {
  navigate: [[words('Go to'), field('url', NAVIGATION), optional(field('scripts', wordsFor(SCRIPT_MODE_WORDS)))]],
  click: [[words('Click'), field('locator', LOCATOR)]],
  download: [[words('Download'), field('name', TEXT), words('by clicking'), field('locator', LOCATOR)]],
  hover: [[words('Hover'), field('locator', LOCATOR)]],
  fill: [[words('Type'), field('value', choice(SECRET, LINES, TEXT)), words('into'), field('locator', LOCATOR)]],
  select: [[words('Select'), field('option', TEXT), words('in'), field('locator', LOCATOR)]],
  upload: [[words('Upload fixture'), field('fixture', TEXT), words('to'), field('locator', LOCATOR)]],
  press: [[words('Press'), KEY_CHORD, words('in'), field('locator', LOCATOR)]],
  frame: [[words('In frame'), field('locator', LOCATOR)]],
  dialog: [[field('action', wordsFor(DIALOG_ACTION_WORDS)), words('dialog'), optional(words('expecting'), field('expectText', TEXT))]],
  expect: [[words('Expect'), field('locator', LOCATOR), field('assert', ELEMENT_ASSERTION)]],
  expectPage: [[words('Expect page'), field('assert', variants('kind', PAGE_CHECK_FORMS))]],
  expectDownload: [[words('Expect download'), field('download', TEXT), field('assert', variants('kind', DOWNLOAD_CHECK_FORMS))]],
  newTab: [[words('In new tab at'), field('url', NAVIGATION)]],
  a11yAudit: [[words('Check accessibility as'), field('mode', oneOf(AUDIT_MODES))]],
  capture: [[words('Capture'), field('name', TEXT)]],
  remember: [[words('Remember'), field(FROM_FIELD, REMEMBER_SOURCE), words('as'), field('name', BARE)]],
  call: [[words('Call'), field('call', BARE), CALL_ARGUMENTS, REMEMBERING]],
  expectBackend: [[
    words('Expect backend'), field('call', BARE), CALL_ARGUMENTS, words('field'), field('field', BARE), field('assert', variants('kind', BACKEND_CHECK_FORMS)),
  ]],
  stub: [
    [words('Start stub'), constant('action', 'start'), field('stub', BARE), OPTIONAL_ARGUMENTS],
    [words('Stop stub'), constant('action', 'stop'), field('stub', BARE)],
  ],
  resetRequests: [[words('Reset requests'), field('request', BARE)]],
  expectRequests: [[words('Expect requests'), field('request', BARE), words('count is'), field('count', REQUEST_COUNT)]],
  expectResponse: [[words('Expect response'), field('request', BARE), field('assert', variants('kind', RESPONSE_CHECK_FORMS))]],
  setStorage: [[words('Set storage entry'), field('entry', BARE), OPTIONAL_ARGUMENTS]],
  removeStorage: [[words('Remove storage entry'), field('entry', BARE)]],
  expectStorage: [[words('Expect storage entry'), field('entry', BARE), field('assert', variants('kind', STORAGE_CHECK_FORMS))]],
  advanceClock: [[words('Advance clock by'), field('by', CLOCK_ADVANCE), optional(field('mode', wordsFor(CLOCK_MODE_WORDS)))]],
  expectClipboard: [[words('Expect clipboard'), field('assert', variants('kind', CLIPBOARD_CHECK_FORMS))]],
  // Page scripts and database commands are unsafe plan features, written in JSON until the readable
  // format gives them a form.
  evaluate: [[NO_READABLE_FORM]],
  expectScript: [[NO_READABLE_FORM]],
  database: [[NO_READABLE_FORM]],
  expectDatabase: [[NO_READABLE_FORM]],
};

// Each step type's statement: its forms, each a whole line.
export const STEP_STATEMENTS: readonly { readonly type: StepType; readonly syntax: Syntax }[] = STEP_TYPES.map((type) =>
  ({ type, syntax: choice(...STEP_FORMS[type].map((parts) => record([constant('type', type), ...parts, END]))) }));

// ---- Headers and other lines ----------------------------------------------------------------------

// `Criterion: <criterion id>` sets the criterion id of every check after it, until the next one.
export const CRITERION_LINE = record([words('Criterion:'), field('criterion', BARE), END]);
// The two statements that open a block of their own lines.
export const VALUES_LINE = record([words('Values:'), END]);
export const CLEANUP_LINE = record([words('Clean up:'), END]);

// A header: its name, where its value goes in the plan's JSON, and the syntax of that value. A
// header with no path is read but never written: Origin: only resolves paths in Go to lines.
export type Header = { readonly name: string; readonly path: readonly string[] | null; readonly required: boolean; readonly line: Syntax };
const header = (name: string, path: readonly string[] | null, value: Syntax, required = false): Header =>
  ({ name, path, required, line: record([words(name), field('value', value), END]) });

// The headers, in the order the writer writes them. The reader takes them in any order.
export const HEADERS: readonly Header[] = [
  header('Plan:', ['meta', 'title'], HEADER_TEXT, true),
  header('Feature:', ['meta', 'featureId'], BARE),
  header('Spec:', ['meta', 'specReference'], HEADER_TEXT),
  header('Version:', ['version'], BARE, true),
  header('Targets:', ['targets'], list(BARE), true),
  header('Saved session:', ['storageState'], SECRET),
  header('Clock:', ['clock'], record([field('day', DAY), words('at'), field('time', BARE)])),
  header('Origin:', null, BARE),
];
