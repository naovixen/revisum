// Shared setup for the readable plan format tests: a plain-text form of every plan, read into plain
// JSON by readPlanText and parsed by the one plan parser, and written back by writePlanText.
//
//   - readableProject() is the shared test project (plan-examples.ts) with what the coverage plans
//     below also need: an upload fixture, two more secret names, a declared test-id attribute and
//     clock limits that let one advance move a whole day;
//   - COVERAGE_PLANS are plans in language 1.2 that, with the golden plans, use every step type,
//     locator kind, role, assertion kind, key, value form and top-level field of the language;
//   - generatedPlans() is the property test's generator: the coverage plans and the golden plans
//     with their page-facing text replaced by seeded random text that is hard to write down
//     (quotes, backslashes, "#", grammar words, leading and trailing spaces, non-ASCII letters);
//   - the text helpers find, replace, insert and remove whole lines of a readable plan.
//
// Every plan here is built as JSON and parsed before it is used, so a plan the parser refuses is a
// broken test and throws. Readable text is written by hand only in the statements the spec gives
// (its grammar, the plan 1.2 addition and its examples); otherwise it comes from writePlanText.
// See docs/specs/SPEC-28-plan-authoring.md.
import {
  CLOCK_ADVANCE_MODES, CLOCK_UNITS, DATE_ANCHORS, DATE_FORMATS, ELEMENT_STATE_KINDS, GENERATED_VALUE_KINDS, KEYS, LOCATOR_KINDS, MODIFIERS,
  REQUEST_COUNT_KINDS, ROLES, planParser,
  type Plan, type Project, type StepType,
} from '@revisum/engine';
import { TARGET_ID, TEST_SERVICE_SECRET_NAMES, goldenPlan, goldenPlanNames, testProject, type JsonRecord } from './plan-examples.ts';

export { ORIGIN, PRIVATE_MARKER, TARGET_ID, goldenPlan, goldenPlanNames, signupPlan, type JsonRecord } from './plan-examples.ts';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

// ---- The project --------------------------------------------------------------------------------

export const UPLOAD_FIXTURE = 'avatar.png';
// A secret a fill step names, and the secret holding saved browser storage state.
export const FILL_SECRET = 'TEST_USER';
export const STORAGE_STATE_SECRET = 'SAVED_SESSION';
export const EXTRA_TEST_ID_ATTRIBUTE = 'data-qa';

export function readableProject(): Project {
  return testProject(
    { maximumClockAdvanceMilliseconds: DAY_IN_MILLISECONDS, maximumTotalClockAdvanceMilliseconds: 2 * DAY_IN_MILLISECONDS },
    {
      fixtures: [UPLOAD_FIXTURE],
      secretNames: [...TEST_SERVICE_SECRET_NAMES, FILL_SECRET, STORAGE_STATE_SECRET],
      testIdAttributes: ['data-testid', EXTRA_TEST_ID_ATTRIBUTE],
    },
  );
}

// The plan parser's type: what planParser(project) returns.
export type ParsePlan = ReturnType<typeof planParser>;

export const readableParser = (): ParsePlan => planParser(readableProject());
// The limits readPlanText checks text against: the project's own.
export const readableLimits = () => readableProject().limits;

// The plan the parser makes from `input`; a refusal is a broken test.
export function parsedWith(parsePlan: ParsePlan, input: unknown, label: string): Plan {
  const parsed = parsePlan(input);
  if (!parsed.ok) throw new Error(`${label} was refused: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// ---- Plans that cover the language ----------------------------------------------------------------

const META = (featureId: string, title: string): JsonRecord => ({ featureId, specReference: `specs/${featureId.toLowerCase()}.md#all`, title });
const planOf = (featureId: string, title: string, steps: readonly unknown[], extra: JsonRecord = {}): JsonRecord =>
  ({ version: '1.2', meta: META(featureId, title), targets: [TARGET_ID], ...extra, steps });

const role = (name: unknown, roleName: string, position?: unknown): JsonRecord =>
  ({ by: 'role', role: roleName, name, ...(position === undefined ? {} : { position }) });
const label = (text: unknown, position?: unknown): JsonRecord => ({ by: 'label', label: text, ...(position === undefined ? {} : { position }) });
const text = (value: unknown, position?: unknown): JsonRecord => ({ by: 'text', text: value, ...(position === undefined ? {} : { position }) });
const testId = (id: unknown, attribute?: string, position?: unknown): JsonRecord =>
  ({ by: 'testId', testId: id, ...(attribute === undefined ? {} : { attribute }), ...(position === undefined ? {} : { position }) });
const expect = (locator: JsonRecord, assertion: JsonRecord, criterionId: string): JsonRecord =>
  ({ type: 'expect', locator, assert: assertion, criterionId });
const expectPage = (assertion: JsonRecord, criterionId: string): JsonRecord => ({ type: 'expectPage', assert: assertion, criterionId });
const click = (locator: JsonRecord): JsonRecord => ({ type: 'click', locator });
const reference = (valueName: string): JsonRecord => ({ valueName });

// Positions in every written form: the words, 1 (written "1st", unlike "first"), and ordinals
// whose English suffix is irregular (11th, 12th, 13th, 21st, 22nd, 23rd, 101st), up to the largest.
const POSITIONS: readonly unknown[] = [undefined, 'first', 'last', 1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 1000];

// Every element check, on locators that use every role, every locator kind and every position form.
function everyElementCheck(): JsonRecord {
  const states = ELEMENT_STATE_KINDS.map((kind, index) => {
    const roleName = ROLES[index % ROLES.length] ?? 'button';
    // A positioned locator may not be counted, so absent keeps its locator unpositioned.
    const position = kind === 'absent' ? undefined : POSITIONS[index % POSITIONS.length];
    return expect(role(`Control ${index}`, roleName, position), { kind }, `checks.state-${kind}`);
  });
  const remainingRoles = ROLES.slice(ELEMENT_STATE_KINDS.length).map((roleName, index) => click(role(`Remaining ${index}`, roleName)));
  return planOf('CHECKS-1', 'Every element check', [
    { type: 'navigate', url: '/checks' },
    ...states,
    expect(label('Full name', 'first'), { kind: 'textEquals', value: 'Ada Lovelace' }, 'checks.text-equals'),
    expect(text('Welcome', 'last'), { kind: 'textContains', value: 'Welcome' }, 'checks.text-contains'),
    expect(testId('email-field'), { kind: 'valueEquals', value: 'ada@example.test' }, 'checks.value-equals'),
    expect(testId('email-field', EXTRA_TEST_ID_ATTRIBUTE, 3), { kind: 'valueContains', value: '@example' }, 'checks.value-contains'),
    expect(role('Result', 'listitem'), { kind: 'countEquals', value: 3 }, 'checks.count-equals'),
    expect(role('Help', 'link'), { kind: 'hrefEquals', value: '/help' }, 'checks.href-equals'),
    ...remainingRoles,
    click(role('Second result', 'link', 2)),
  ]);
}

// Every action step, the frame and dialog forms, both audit modes, and every page check.
function everyAction(): JsonRecord {
  return planOf('ACTIONS-1', 'Every action: "quoted", back\\slash and # sign', [
    { type: 'navigate', url: 'http://127.0.0.1:4173/settings', scripts: 'disabled' },
    expectPage({ kind: 'title', value: 'Settings' }, 'actions.server-title'),
    { type: 'navigate', url: '/settings' },
    click(role('Save', 'button')),
    { type: 'hover', locator: text('More options') },
    { type: 'fill', locator: label('Display name'), value: 'Ada "the Countess" \\ Lovelace' },
    { type: 'fill', locator: label('Email'), value: { secretName: FILL_SECRET } },
    { type: 'select', locator: label('Country'), option: 'United Kingdom' },
    { type: 'upload', locator: label('Avatar'), fixture: UPLOAD_FIXTURE },
    { type: 'press', locator: role('Search', 'searchbox'), key: 'Enter' },
    { type: 'press', locator: role('Search', 'searchbox'), key: 'a', modifiers: ['Alt', 'Control', 'Meta', 'Shift'] },
    {
      type: 'frame', locator: testId('outer-frame'), steps: [
        {
          type: 'frame', locator: role('Inner', 'region'), steps: [
            click(role('Inner save', 'button')),
            expect(text('Inner saved'), { kind: 'visible' }, 'actions.inner-saved'),
          ],
        },
        { type: 'fill', locator: label('Note'), value: 'In a frame' },
      ],
    },
    { type: 'dialog', action: 'accept' },
    click(role('Leave', 'button')),
    { type: 'dialog', action: 'dismiss', expectText: 'Leave this page?' },
    { type: 'a11yAudit', mode: 'gate' },
    { type: 'a11yAudit', mode: 'report' },
    { type: 'capture', name: 'settings-saved' },
    expectPage({ kind: 'urlPath', value: '/settings' }, 'actions.url-path'),
    expectPage({ kind: 'url', value: 'http://127.0.0.1:4173/settings?saved=1' }, 'actions.url'),
    expectPage({ kind: 'urlPathStartsWith', value: '/settings' }, 'actions.url-prefix'),
    expectPage({ kind: 'metaContent', name: 'og:title', value: 'Settings' }, 'actions.meta-content'),
    expectPage({ kind: 'canonicalUrl', value: 'https://example.org/settings' }, 'actions.canonical-url'),
  ]);
}

// Every key a press step may name, one press each, and a chord of the platform modifier.
function everyKey(): JsonRecord {
  return planOf('KEYS-1', 'Every key', [
    { type: 'navigate', url: '/editor' },
    ...KEYS.map((key) => ({ type: 'press', locator: role('Editor', 'textbox'), key })),
    { type: 'press', locator: role('Editor', 'textbox'), key: 's', modifiers: ['ControlOrMeta'] },
    expect(role('Editor', 'textbox'), { kind: 'focused' }, 'keys.editor-focused'),
  ]);
}

// A download with every download check, and second tabs opened by a path and by a path template.
function downloadsAndTabs(): JsonRecord {
  const check = (assertion: JsonRecord, criterionId: string): JsonRecord =>
    ({ type: 'expectDownload', download: 'project-list', assert: assertion, criterionId });
  return planOf('EXPORT-2', 'Downloads and tabs', [
    { type: 'navigate', url: '/projects' },
    { type: 'download', name: 'project-list', locator: role('Export CSV', 'button') },
    check({ kind: 'fileNameEquals', value: 'projects.csv' }, 'export.file-name'),
    check({ kind: 'contentContains', value: 'Relaunch' }, 'export.content-contains'),
    check({ kind: 'contentExcludes', value: 'Archived' }, 'export.content-excludes'),
    check({ kind: 'mediaTypeEquals', value: 'text/csv' }, 'export.media-type'),
    check({ kind: 'sizeAtMost', value: 65_536 }, 'export.size-at-most'),
    check({ kind: 'sizeAtLeast', value: 1 }, 'export.size-at-least'),
    {
      type: 'newTab', url: { segments: ['projects', 'archive'], query: { sort: 'name' } }, steps: [
        expect(role('Archive', 'heading'), { kind: 'visible' }, 'export.archive-tab'),
      ],
    },
    { type: 'newTab', url: '/projects/new', steps: [expectPage({ kind: 'urlPath', value: '/projects/new' }, 'export.new-tab')] },
  ]);
}

// Every generated value kind and date format, the plan clock, value references in every place
// they may stand, multi-line fills and every remember source that reads the page or the clipboard.
function valuesAndRemembering(): JsonRecord {
  const dates = Object.fromEntries(DATE_FORMATS.map((format, index) => [
    `${format}Day`,
    { kind: 'date', day: { from: DATE_ANCHORS[index % DATE_ANCHORS.length], addDays: [-3, 0, 14, 3660, -3660, 1, 7][index] ?? 0 }, format },
  ]));
  return planOf('VALUES-9', 'Run values everywhere', [
    { type: 'navigate', url: { segments: ['members', reference('memberCode')], query: { tab: 'profile', code: reference('memberNumber') } } },
    { type: 'fill', locator: label('Name'), value: reference('displayName') },
    { type: 'fill', locator: role('Message', 'textbox'), value: { lines: ['First "line"', reference('displayName'), '  indented third line'] } },
    { type: 'fill', locator: testId(reference('memberCode')), value: reference('contact') },
    { type: 'select', locator: label('Day'), option: reference('dayOfMonthDay') },
    { type: 'remember', name: 'shownName', from: { element: testId('name'), read: 'text' } },
    { type: 'remember', name: 'fieldValue', from: { element: label('Name'), read: 'value' } },
    click(role('Copy link', 'button')),
    { type: 'remember', name: 'copiedLink', from: { clipboard: 'text' } },
    { type: 'dialog', action: 'accept', expectText: reference('copiedLink') },
    expect(role(reference('shownName'), 'heading'), { kind: 'visible' }, 'values.name-shown'),
    expect(label(reference('displayName')), { kind: 'valueEquals', value: reference('fieldValue') }, 'values.field-kept'),
    expect(text(reference('longDateDay')), { kind: 'textContains', value: reference('weekdayDay') }, 'values.date-shown'),
    expectPage({ kind: 'metaContent', name: 'description', value: reference('monthAndYearDay') }, 'values.meta-month'),
  ], {
    values: {
      displayName: { kind: 'uniqueText', prefix: 'Tester' },
      memberCode: { kind: 'uniqueText', prefix: 'member' },
      contact: { kind: 'uniqueEmail', localPrefix: 'ada.lovelace', domain: 'example.com' },
      memberNumber: { kind: 'uniqueNumber', digits: 6 },
      ...dates,
    },
    clock: { day: { from: 'startOfWeek', addDays: 2 }, time: '13:45' },
  });
}

// Every declared-call step form: calls with literal, numeric, boolean, secret and run-value
// arguments, remembered fields, every backend check, and a cleanup of two calls.
function serviceCalls(): JsonRecord {
  const backend = (field: string, assertion: JsonRecord, criterionId: string): JsonRecord =>
    ({ type: 'expectBackend', call: 'getOrder', arguments: { orderId: reference('orderId') }, field, assert: assertion, criterionId });
  return planOf('ORDERS-9', 'Every backend check', [
    {
      type: 'call', call: 'createOrder',
      arguments: { customerName: 'Ada Lovelace', contactEmail: 'ada@example.com', quantity: 2, region: 'eu', giftWrap: true, deliveryDay: '2026-11-02' },
      remember: { orderId: 'orderId', orderStatus: 'status' },
    },
    { type: 'call', call: 'signInAsAdmin', arguments: { adminPassword: { secretName: 'SHOP_ADMIN_PASSWORD' } }, remember: { adminSession: 'sessionId' } },
    { type: 'navigate', url: { segments: ['orders', reference('orderId')] } },
    backend('status', { kind: 'present' }, 'orders.status-present'),
    backend('total', { kind: 'absent' }, 'orders.total-absent'),
    backend('status', { kind: 'equals', value: 'paid' }, 'orders.paid'),
    backend('status', { kind: 'contains', value: reference('orderStatus') }, 'orders.status-kept'),
    backend('total', { kind: 'numberEquals', value: 42 }, 'orders.total'),
    // Numbers are written as JSON writes them, fractions and negatives included.
    backend('total', { kind: 'numberEquals', value: 0.5 }, 'orders.total-fraction'),
    backend('total', { kind: 'numberEquals', value: -5 }, 'orders.total-negative'),
    { type: 'call', call: 'resetShop', arguments: {} },
  ], {
    cleanup: [
      { type: 'call', call: 'deleteOrder', arguments: { orderId: reference('orderId') } },
      { type: 'call', call: 'resetShop', arguments: {} },
    ],
  });
}

// Stubs, request checks of every count and response kind, storage, every clock unit and mode,
// and every clipboard check.
function networkStorageClockAndClipboard(): JsonRecord {
  const response = (assertion: JsonRecord, criterionId: string): JsonRecord => ({ type: 'expectResponse', request: 'likes', assert: assertion, criterionId });
  return planOf('LIKES-9', 'Network, storage, clock and clipboard', [
    { type: 'stub', stub: 'loginNeedsCode', action: 'start', arguments: { reason: 'Enter the code from your app' } },
    { type: 'navigate', url: '/transactions' },
    { type: 'resetRequests', request: 'likes' },
    click(role('Like', 'button')),
    { type: 'expectRequests', request: 'likes', count: { equals: 1 }, criterionId: 'likes.one' },
    { type: 'expectRequests', request: 'likes', count: { atLeast: 1 }, criterionId: 'likes.some' },
    { type: 'expectRequests', request: 'likes', count: { atMost: 2 }, criterionId: 'likes.few' },
    response({ kind: 'statusEquals', value: 200 }, 'likes.accepted'),
    response({ kind: 'fieldPresent', field: 'likeList' }, 'likes.list'),
    response({ kind: 'fieldAbsent', field: 'errorCode' }, 'likes.no-error'),
    response({ kind: 'fieldEquals', field: 'firstLiker', value: 'Ada Lovelace' }, 'likes.first-liker'),
    response({ kind: 'fieldContains', field: 'firstLiker', value: 'Ada' }, 'likes.first-liker-named'),
    { type: 'remember', name: 'likeCount', from: { response: 'likes', field: 'likeList', read: 'arrayLength' } },
    { type: 'remember', name: 'firstLiker', from: { response: 'likes', field: 'firstLiker', read: 'text' } },
    expect(testId('like-count'), { kind: 'textEquals', value: reference('likeCount') }, 'likes.count-shown'),
    { type: 'setStorage', entry: 'pinnedMenu', arguments: { docked: false } },
    { type: 'expectStorage', entry: 'pinnedMenu', assert: { kind: 'equals', value: 'false' }, criterionId: 'menu.undocked' },
    { type: 'expectStorage', entry: 'privateKey', assert: { kind: 'present' }, criterionId: 'menu.key-kept' },
    { type: 'removeStorage', entry: 'pinnedMenu' },
    { type: 'expectStorage', entry: 'pinnedMenu', assert: { kind: 'absent' }, criterionId: 'menu.removed' },
    { type: 'stub', stub: 'loginNeedsCode', action: 'stop' },
    { type: 'advanceClock', by: { amount: 250, unit: 'milliseconds' } },
    { type: 'advanceClock', by: { amount: 30, unit: 'seconds' }, mode: 'runTimers' },
    { type: 'advanceClock', by: { amount: 10, unit: 'minutes' }, mode: 'skipAhead' },
    { type: 'advanceClock', by: { amount: 2, unit: 'hours' } },
    { type: 'advanceClock', by: { amount: 1, unit: 'days' }, mode: 'skipAhead' },
    click(role('Copy invite link', 'button')),
    { type: 'expectClipboard', assert: { kind: 'textEquals', value: { lines: ['Join us', 'at the link below'] } }, criterionId: 'invite.lines' },
    { type: 'expectClipboard', assert: { kind: 'textContains', value: reference('firstLiker') }, criterionId: 'invite.named' },
    { type: 'expectClipboard', assert: { kind: 'textExcludes', value: 'draft' }, criterionId: 'invite.final' },
    { type: 'expectClipboard', assert: { kind: 'textEquals', value: 'Join us' }, criterionId: 'invite.single-line' },
  ]);
}

// The forms where JSON tells an empty field from an absent one: an empty values block, an empty
// cleanup, an empty query, a call remembering nothing, and a header text that must be quoted.
function emptyForms(): JsonRecord {
  return {
    version: '1.2',
    meta: { featureId: 'EMPTY-1', specReference: ' specs/empty.md#padded ', title: '"Quoted" title with {braces}, commas: and # ' },
    targets: [TARGET_ID],
    values: {},
    steps: [
      { type: 'navigate', url: { segments: ['search'], query: {} } },
      { type: 'navigate', url: { segments: ['search', 'all'] } },
      { type: 'call', call: 'resetShop', arguments: {}, remember: {} },
      { type: 'call', call: 'resetShop', arguments: {} },
      expect(text('{notReference}'), { kind: 'visible' }, 'empty.braces-are-text'),
    ],
    cleanup: [],
  };
}

// Saved browser storage state, which a plan names as a secret.
function savedSession(): JsonRecord {
  return planOf('SESSION-9', 'A saved session', [
    { type: 'navigate', url: '/' },
    expect(role('Welcome back', 'heading'), { kind: 'visible' }, 'session.restored'),
  ], { storageState: { secretName: STORAGE_STATE_SECRET } });
}

export const COVERAGE_PLANS: Readonly<Record<string, () => JsonRecord>> = {
  'every-element-check': everyElementCheck,
  'every-action': everyAction,
  'every-key': everyKey,
  'downloads-and-tabs': downloadsAndTabs,
  'values-and-remembering': valuesAndRemembering,
  'service-calls': serviceCalls,
  'network-storage-clock-and-clipboard': networkStorageClockAndClipboard,
  'saved-session': savedSession,
  'empty-forms': emptyForms,
};

// Every example: the golden plans and the coverage plans, by name.
export function everyExample(): readonly { readonly name: string; readonly plan: JsonRecord }[] {
  return [
    ...goldenPlanNames().map((name) => ({ name: `golden ${name}`, plan: goldenPlan(name) })),
    ...Object.entries(COVERAGE_PLANS).map(([name, build]) => ({ name: `coverage ${name}`, plan: build() })),
  ];
}

// ---- What a set of plans covers -------------------------------------------------------------------

// Every step type of the language. The check below fails to compile when the Step union gains a
// type this list leaves out, so the coverage test cannot silently miss a new step.
export const EVERY_STEP_TYPE = [
  'navigate', 'click', 'download', 'hover', 'fill', 'select', 'upload', 'press', 'frame', 'dialog', 'expect', 'expectPage',
  'expectDownload', 'newTab', 'a11yAudit', 'capture', 'remember', 'call', 'expectBackend', 'stub', 'resetRequests',
  'expectRequests', 'expectResponse', 'setStorage', 'removeStorage', 'expectStorage', 'advanceClock', 'expectClipboard',
] as const satisfies readonly StepType[];
type StepTypeLeftOut = Exclude<StepType, (typeof EVERY_STEP_TYPE)[number]>;
export const NO_STEP_TYPE_LEFT_OUT: [StepTypeLeftOut] extends [never] ? true : false = true;

// The features a plan uses, as words such as "step navigate", "locator role",
// "assert expectPage canonicalUrl" or "value date", so a test can compare them with every
// construct of the language, the readable form's plan 1.2 addition included.
export function featuresOf(plan: JsonRecord): Set<string> {
  const features = new Set<string>();
  const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
  const visitText = (value: unknown, where: string): void => {
    if (isRecord(value) && Object.hasOwn(value, 'valueName')) features.add(`reference in ${where}`);
  };
  const visitLocator = (locator: JsonRecord): void => {
    features.add(`locator ${String(locator['by'])}`);
    if (locator['by'] === 'role') features.add(`role ${String(locator['role'])}`);
    const position = locator['position'];
    if (typeof position === 'string') features.add(`position ${position}`);
    if (typeof position === 'number') features.add(position === 1 ? 'position 1' : 'position ordinal');
    if (Object.hasOwn(locator, 'attribute')) features.add('locator attribute');
    for (const field of ['name', 'label', 'text', 'testId']) visitText(locator[field], 'locator');
  };
  const visitUrl = (url: unknown): void => {
    if (typeof url === 'string') features.add(url.startsWith('/') ? 'url path' : 'url absolute');
    if (!isRecord(url)) return;
    features.add('url path template');
    if (isRecord(url['query'])) features.add(Object.keys(url['query']).length === 0 ? 'url empty query' : 'url query');
  };
  const visitArguments = (step: JsonRecord): void => {
    const args = step['arguments'];
    if (!isRecord(args)) return;
    if (Object.keys(args).length === 0) features.add(`${String(step['type'])} with no arguments`);
    for (const value of Object.values(args)) {
      features.add(`argument ${isRecord(value) ? Object.keys(value)[0] ?? 'object' : typeof value}`);
    }
  };
  const visitSteps = (steps: readonly JsonRecord[]): void => {
    for (const step of steps) {
      const type = String(step['type']);
      features.add(`step ${type}`);
      const locator = step['locator'];
      if (isRecord(locator)) visitLocator(locator);
      const assertion = step['assert'];
      if (isRecord(assertion)) {
        features.add(`assert ${type} ${String(assertion['kind'])}`);
        visitText(assertion['value'], 'check');
        if (isRecord(assertion['value']) && Object.hasOwn(assertion['value'], 'lines')) features.add(`lines in ${type}`);
      }
      if (type === 'press') {
        features.add(`key ${String(step['key'])}`);
        for (const modifier of (step['modifiers'] ?? []) as string[]) features.add(`modifier ${modifier}`);
      }
      if (type === 'navigate' || type === 'newTab') visitUrl(step['url']);
      if (type === 'navigate' && step['scripts'] === 'disabled') features.add('scripts disabled');
      if (type === 'fill') {
        const value = step['value'];
        features.add(`fill ${typeof value === 'string' ? 'text' : isRecord(value) ? Object.keys(value)[0] ?? 'object' : typeof value}`);
      }
      if (type === 'select') visitText(step['option'], 'option');
      if (type === 'dialog') features.add(Object.hasOwn(step, 'expectText') ? `dialog ${String(step['action'])} expecting` : `dialog ${String(step['action'])}`);
      if (type === 'remember' && isRecord(step['from'])) {
        const from = step['from'];
        const source = Object.keys(from).find((key) => key !== 'read' && key !== 'field') ?? 'unknown';
        features.add(`remember ${source}${typeof from['read'] === 'string' ? ` ${from['read']}` : ''}`);
      }
      if (type === 'call') {
        if (isRecord(step['remember'])) features.add(Object.keys(step['remember']).length === 0 ? 'call remembering nothing' : 'call remembering');
      }
      if (type === 'call' || type === 'expectBackend' || type === 'stub' || type === 'setStorage') visitArguments(step);
      if (type === 'stub') features.add(`stub ${String(step['action'])}`);
      if (type === 'expectRequests' && isRecord(step['count'])) features.add(`count ${Object.keys(step['count'])[0] ?? 'none'}`);
      if (type === 'advanceClock') {
        const by = isRecord(step['by']) ? step['by'] : {};
        features.add(`unit ${String(by['unit'])}`);
        features.add(`advance ${typeof step['mode'] === 'string' ? step['mode'] : 'default mode'}`);
      }
      const nested = step['steps'];
      if (Array.isArray(nested)) visitSteps(nested as JsonRecord[]);
    }
  };
  for (const field of Object.keys(plan)) features.add(`field ${field}`);
  if (isRecord(plan['values'])) {
    if (Object.keys(plan['values']).length === 0) features.add('empty values');
    for (const value of Object.values(plan['values'])) {
      if (!isRecord(value)) continue;
      features.add(`value ${String(value['kind'])}`);
      if (value['kind'] === 'uniqueEmail') features.add(Object.hasOwn(value, 'domain') ? 'email with domain' : 'email without domain');
      if (value['kind'] === 'date') {
        features.add(`format ${String(value['format'])}`);
        const day = isRecord(value['day']) ? value['day'] : {};
        features.add(`anchor ${String(day['from'])}`);
        const addDays = Number(day['addDays']);
        features.add(addDays === 0 ? 'day anchor alone' : addDays === 1 ? 'day one after' : addDays > 0 ? 'days after' : 'days before');
      }
    }
  }
  if (Array.isArray(plan['cleanup']) && plan['cleanup'].length === 0) features.add('empty cleanup');
  visitSteps((plan['steps'] ?? []) as JsonRecord[]);
  visitSteps((plan['cleanup'] ?? []) as JsonRecord[]);
  return features;
}

// What the whole language offers, in the words featuresOf uses. Assertion kinds are listed per step.
export function languageFeatures(): readonly string[] {
  const assertKinds: Readonly<Record<string, readonly string[]>> = {
    expect: [...ELEMENT_STATE_KINDS, 'textEquals', 'textContains', 'valueEquals', 'valueContains', 'countEquals', 'hrefEquals'],
    expectPage: ['title', 'urlPath', 'url', 'urlPathStartsWith', 'metaContent', 'canonicalUrl'],
    expectDownload: ['fileNameEquals', 'contentContains', 'contentExcludes', 'mediaTypeEquals', 'sizeAtMost', 'sizeAtLeast'],
    expectBackend: ['present', 'absent', 'equals', 'contains', 'numberEquals'],
    expectResponse: ['statusEquals', 'fieldPresent', 'fieldAbsent', 'fieldEquals', 'fieldContains'],
    expectStorage: ['present', 'absent', 'equals'],
    expectClipboard: ['textEquals', 'textContains', 'textExcludes'],
  };
  return [
    ...EVERY_STEP_TYPE.map((type) => `step ${type}`),
    ...LOCATOR_KINDS.map((kind) => `locator ${kind}`),
    ...ROLES.map((roleName) => `role ${roleName}`),
    'position first', 'position last', 'position 1', 'position ordinal', 'locator attribute',
    'reference in locator', 'reference in check', 'reference in option',
    ...Object.entries(assertKinds).flatMap(([type, kinds]) => kinds.map((kind) => `assert ${type} ${kind}`)),
    'lines in expectClipboard',
    ...KEYS.map((key) => `key ${key}`),
    ...MODIFIERS.map((modifier) => `modifier ${modifier}`),
    'url path', 'url absolute', 'url path template', 'url query', 'url empty query', 'scripts disabled',
    'fill text', 'fill valueName', 'fill secretName', 'fill lines',
    'dialog accept', 'dialog dismiss expecting', 'dialog accept expecting',
    'remember element text', 'remember element value', 'remember response text', 'remember response arrayLength', 'remember clipboard',
    'call remembering', 'call remembering nothing', 'call with no arguments',
    'argument string', 'argument number', 'argument boolean', 'argument valueName', 'argument secretName',
    'stub start', 'stub stop', ...REQUEST_COUNT_KINDS.map((kind) => `count ${kind}`),
    ...CLOCK_UNITS.map((unit) => `unit ${unit}`), 'advance default mode', ...CLOCK_ADVANCE_MODES.map((mode) => `advance ${mode}`),
    ...GENERATED_VALUE_KINDS.map((kind) => `value ${kind}`), 'email with domain', 'email without domain',
    ...DATE_FORMATS.map((format) => `format ${format}`), ...DATE_ANCHORS.map((anchor) => `anchor ${anchor}`),
    'day anchor alone', 'day one after', 'days after', 'days before', 'empty values', 'empty cleanup',
    ...['version', 'meta', 'targets', 'steps', 'storageState', 'values', 'clock', 'cleanup'].map((field) => `field ${field}`),
  ];
}

// ---- The property test's generator ---------------------------------------------------------------

// A small seeded generator (mulberry32), so a failing case can be replayed from its seed.
export function seededNumbers(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

// Pieces of text that are hard to write down in a line-based grammar: quotes and backslashes,
// the comment sign, words of the grammar itself, separators, and letters outside ASCII. None is a
// control character, looks like script, or names a sensitive field, so the parser accepts them.
const AWKWARD_PIECES = [
  '"', '\\', '\\"', '#', '# not a comment', ' is visible', ' has text ', ' into ', ' in ', 'Criterion: AC-9', 'Plan: x',
  ':', ', ', '  ', ' ', 'Ünïcödé', '日本語', 'émoji 🙂', '→', "it's", '[1]', '{x}', '%20', 'Go to /', 'label "x"',
  'Ada', 'Lovelace', 'order', 'total', '42', '-', '_', '.', '/',
];

function awkwardText(next: () => number): string {
  const count = 1 + Math.floor(next() * 5);
  let result = '';
  for (let index = 0; index < count; index += 1) result += AWKWARD_PIECES[Math.floor(next() * AWKWARD_PIECES.length)] ?? 'x';
  // Text must not be empty or blank-only for every field, so keep a letter in it.
  return /[A-Za-z]/.test(result) ? result : `${result}Ada`;
}

// Fields whose text a person reads on the page, which the generator may replace: locator names,
// labels and texts, filled values and lines, options, dialog text, the plan's title and spec reference, and the
// expected text of text checks.
const TEXT_ASSERTION_KINDS = ['textEquals', 'textContains', 'valueEquals', 'valueContains'];
const CLIPBOARD_TEXT_KINDS = ['textContains', 'textExcludes'];

function replaceText(value: unknown, next: () => number, key: string, parent: JsonRecord | null, stepType: string | null): unknown {
  if (typeof value === 'string') {
    const inLocator = parent !== null && typeof parent['by'] === 'string' && (key === 'name' || key === 'label' || key === 'text');
    const inStep = stepType !== null && parent !== null && parent['type'] === stepType
      && ((stepType === 'fill' && key === 'value') || (stepType === 'select' && key === 'option') || (stepType === 'dialog' && key === 'expectText'));
    const inAssertion = parent !== null && key === 'value' && typeof parent['kind'] === 'string'
      && ((stepType === 'expect' && TEXT_ASSERTION_KINDS.includes(parent['kind']))
        || (stepType === 'expectClipboard' && CLIPBOARD_TEXT_KINDS.includes(parent['kind']))
        || (stepType === 'expectPage' && parent['kind'] === 'title'));
    // The Plan: and Spec: headers' text, which is written quoted when it starts or ends with a space or starts with a quote.
    const inTitle = parent !== null && (key === 'title' || key === 'specReference') && Object.hasOwn(parent, 'featureId');
    return inLocator || inStep || inAssertion || inTitle ? awkwardText(next) : value;
  }
  if (Array.isArray(value)) {
    // The lines of a multi-line fill are text too.
    const lines = key === 'lines';
    return value.map((item) => (lines && typeof item === 'string' ? awkwardText(next) : replaceText(item, next, '', parent, stepType)));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as JsonRecord;
    const ownType = typeof record['type'] === 'string' ? record['type'] : stepType;
    return Object.fromEntries(Object.entries(record).map(([childKey, child]) => [childKey, replaceText(child, next, childKey, record, ownType)]));
  }
  return value;
}

// `count` plans with awkward page-facing text, from every example in turn, each with the seed it
// was made from. Only plans the parser accepts are kept; the caller checks there are enough.
export function generatedPlans(parsePlan: ParsePlan, firstSeed: number, count: number): readonly { readonly seed: number; readonly name: string; readonly plan: JsonRecord }[] {
  const examples = everyExample();
  const generated: { seed: number; name: string; plan: JsonRecord }[] = [];
  for (let seed = firstSeed; seed < firstSeed + count; seed += 1) {
    const example = examples[seed % examples.length];
    if (example === undefined) continue;
    const plan = replaceText(example.plan, seededNumbers(seed), '', null, null) as JsonRecord;
    if (parsePlan(plan).ok) generated.push({ seed, name: example.name, plan });
  }
  return generated;
}

// ---- Lines of a readable plan -----------------------------------------------------------------------

export const linesOf = (text: string): string[] => text.split('\n');
export const joinLines = (lines: readonly string[]): string => lines.join('\n');

// The 1-based number of the one line whose content, without its indentation, is `statement`.
export function lineOf(text: string, statement: string): number {
  const found = linesOf(text).flatMap((line, index) => (line.trim() === statement ? [index + 1] : []));
  if (found.length !== 1) throw new Error(`expected one line "${statement}", found ${found.length} in:\n${text}`);
  return found[0] ?? 0;
}

// The 1-based number of the one line that starts with `prefix`, such as "Version:".
export function lineStartingWith(text: string, prefix: string): number {
  const found = linesOf(text).flatMap((line, index) => (line.startsWith(prefix) ? [index + 1] : []));
  if (found.length !== 1) throw new Error(`expected one line starting "${prefix}", found ${found.length} in:\n${text}`);
  return found[0] ?? 0;
}

export const lineAt = (text: string, line: number): string => linesOf(text)[line - 1] ?? '';

export function withLineReplaced(text: string, line: number, replacement: string): string {
  const lines = linesOf(text);
  lines.splice(line - 1, 1, replacement);
  return joinLines(lines);
}

// Puts `inserted` on line `line`, moving what was there down by one.
export function withLineInserted(text: string, line: number, inserted: string): string {
  const lines = linesOf(text);
  lines.splice(line - 1, 0, inserted);
  return joinLines(lines);
}

export function withLineRemoved(text: string, line: number): string {
  const lines = linesOf(text);
  lines.splice(line - 1, 1);
  return joinLines(lines);
}

// The first words of step statements. Grammar words are case-insensitive, so a re-layout may
// change the case of these words without changing the plan.
export const STATEMENT_WORDS = [
  'Go', 'Click', 'Hover', 'Type', 'Select', 'Upload', 'Press', 'Accept', 'Dismiss', 'In', 'Expect', 'Check', 'Capture',
  'Download', 'Remember', 'Call', 'Start', 'Stop', 'Reset', 'Set', 'Remove', 'Advance',
];
