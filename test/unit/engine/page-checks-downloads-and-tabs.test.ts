// The grammar of plan language 1.2's page checks, downloads and second tab: accessibility state
// checks, the link-target check, head metadata with a server-rendered view, the download and
// expectDownload steps, and newTab, which only the top level of a plan may hold. What a browser
// does with them (the state read from the accessibility tree, the head the server sent, the
// downloaded file, the tab sharing the session) comes with the CDP driver; until then a run
// reports these steps as unsupported-step (unsupported-page-checks.test.ts).
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { defaultRedactor, failure, runUntrusted, type BrowserDriver, type Plan } from '@revisum/engine';
import { memoryArtifactStore, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import {
  CLOSING_CHECK, OPEN_ORDERS, ORIGIN, accepted, label, navigate, parserFor, planOf, projectWith, reference, rejection,
  type JsonRecord,
} from './run-value-examples.ts';

const parsePlan = parserFor();

// A step of a parsed plan as plain JSON, to compare with what the plan wrote.
const parsedStep = (plan: Plan, index: number): unknown => JSON.parse(JSON.stringify(plan.steps[index]));

const BILLING_TAB: JsonRecord = { by: 'role', role: 'tab', name: 'Billing' };
const GUIDE_LINK: JsonRecord = { by: 'role', role: 'link', name: 'Billing guide' };
const EXPORT_BUTTON: JsonRecord = { by: 'role', role: 'button', name: 'Export CSV' };

const expectOn = (locator: JsonRecord, assertion: JsonRecord): JsonRecord =>
  ({ type: 'expect', locator, assert: assertion, criterionId: 'settings.billing-shown' });
const expectPage = (assertion: JsonRecord): JsonRecord => ({ type: 'expectPage', assert: assertion, criterionId: 'events.sharing-title' });
const download = (name: unknown, locator: JsonRecord = EXPORT_BUTTON): JsonRecord => ({ type: 'download', name, locator });
const expectDownload = (name: unknown, assertion: JsonRecord): JsonRecord =>
  ({ type: 'expectDownload', download: name, assert: assertion, criterionId: 'projects.export-checked' });
const newTab = (url: unknown, steps: readonly unknown[] = [CLOSING_CHECK]): JsonRecord => ({ type: 'newTab', url, steps });
const frame = (steps: readonly unknown[]): JsonRecord => ({ type: 'frame', locator: { by: 'testId', testId: 'checkout-frame' }, steps });

// ---- Accessibility states -------------------------------------------------------------------------

const NEW_STATES = ['selected', 'unselected', 'expanded', 'collapsed', 'pressed', 'unpressed', 'current'];

for (const kind of NEW_STATES) {
  test(`the state check "${kind}" is accepted on an expect step and kept as written`, { criterion: 'AC-SPEC-31-01' }, () => {
    const step = expectOn(BILLING_TAB, { kind });
    assert.deepEqual(parsedStep(accepted(parsePlan, planOf([OPEN_ORDERS, step])), 1), step);
  });

  test(`the state check "${kind}" compares against nothing, so a value beside it is refused`, { criterion: 'AC-SPEC-31-01' }, () => {
    assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, expectOn(BILLING_TAB, { kind, value: 'true' })])), ['unknown_field $.steps[1].assert.value']);
  });
}

// Counter-example: a state the language does not have, such as a CSS class's "active", is refused.
test('a state the language does not have, such as "active" or "highlighted", is refused at the kind', { criterion: 'AC-SPEC-31-02' }, () => {
  for (const kind of ['active', 'highlighted', 'open', 'aria-selected']) {
    assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, expectOn(BILLING_TAB, { kind })])), ['unknown_value $.steps[1].assert.kind'], kind);
  }
});

test('state checks are page checks, not page assertions: on expectPage they are refused', { criterion: 'AC-SPEC-31-01' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, expectPage({ kind: 'selected' })])), ['unknown_value $.steps[1].assert.kind']);
});

// ---- Link target ----------------------------------------------------------------------------------

test('hrefEquals takes literal text or a run value and is kept as written', { criterion: 'AC-SPEC-31-03' }, () => {
  const literal = expectOn(GUIDE_LINK, { kind: 'hrefEquals', value: `${ORIGIN}/help/billing` });
  assert.deepEqual(parsedStep(accepted(parsePlan, planOf([OPEN_ORDERS, literal])), 1), literal);
  const values = { guidePath: { kind: 'uniqueText', prefix: 'guide' } };
  const referring = expectOn(GUIDE_LINK, { kind: 'hrefEquals', value: reference('guidePath') });
  assert.deepEqual(parsedStep(accepted(parsePlan, planOf([OPEN_ORDERS, referring], { values })), 1), referring);
});

test('hrefEquals with script-like text is refused as unsafe_text', { criterion: 'AC-SPEC-31-03' }, () => {
  const step = expectOn(GUIDE_LINK, { kind: 'hrefEquals', value: 'javascript:alert(1)' });
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, step])), ['unsafe_text $.steps[1].assert.value']);
});

test('hrefEquals is an element check: on expectPage it is refused', { criterion: 'AC-SPEC-31-03' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, expectPage({ kind: 'hrefEquals', value: `${ORIGIN}/help` })])), ['unknown_value $.steps[1].assert.kind']);
});

// ---- Server-rendered view -------------------------------------------------------------------------

test('navigate takes scripts "disabled", with a URL or a path template, and keeps it', { criterion: 'AC-SPEC-31-04' }, () => {
  for (const url of ['/events/team-meeting', `${ORIGIN}/events/team-meeting`, { segments: ['events', 'team-meeting'] }]) {
    const step = { type: 'navigate', url, scripts: 'disabled' };
    assert.deepEqual(parsedStep(accepted(parsePlan, planOf([step])), 0), step, JSON.stringify(url));
  }
});

test('navigate without scripts keeps no scripts field, so the page runs its scripts as before', { criterion: 'AC-SPEC-31-04' }, () => {
  assert.deepEqual(parsedStep(accepted(parsePlan, planOf([navigate('/events/team-meeting')])), 0), navigate('/events/team-meeting'));
});

test('scripts other than "disabled" are refused at the field', { criterion: 'AC-SPEC-31-04' }, () => {
  for (const scripts of ['enabled', 'off', 'Disabled', '']) {
    assert.deepEqual(rejection(parsePlan, planOf([{ ...navigate('/events'), scripts }])), ['unknown_value $.steps[0].scripts'], scripts);
  }
  for (const scripts of [false, true, 0, null, ['disabled']]) {
    const errors = rejection(parsePlan, planOf([{ ...navigate('/events'), scripts }]));
    assert.deepEqual(errors.map((error) => error.split(' ')[1]), ['$.steps[0].scripts'], JSON.stringify(scripts));
  }
});

// ---- Page metadata --------------------------------------------------------------------------------

test('metaContent takes a tag name and literal text or a run value, and is kept as written', { criterion: 'AC-SPEC-31-05' }, () => {
  for (const name of ['og:title', 'description', 'twitter:card', 'robots']) {
    const step = expectPage({ kind: 'metaContent', name, value: 'Team meeting' });
    assert.deepEqual(parsedStep(accepted(parsePlan, planOf([OPEN_ORDERS, step])), 1), step, name);
  }
  const values = { eventTitle: { kind: 'uniqueText', prefix: 'event' } };
  const referring = expectPage({ kind: 'metaContent', name: 'og:title', value: reference('eventTitle') });
  assert.deepEqual(parsedStep(accepted(parsePlan, planOf([OPEN_ORDERS, referring], { values })), 1), referring);
});

const SCRIPT_LIKE = ['<script>alert(1)</script>', 'javascript:alert(1)', '<img src=x onerror=alert(1)>'];

for (const name of SCRIPT_LIKE) {
  test(`a metaContent name of script-like text ${JSON.stringify(name)} is refused as unsafe_text at the name`, { criterion: 'AC-SPEC-31-05' }, () => {
    assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, expectPage({ kind: 'metaContent', name, value: 'Team meeting' })])), ['unsafe_text $.steps[1].assert.name']);
  });
}

test('a metaContent without a name is refused as missing_field', { criterion: 'AC-SPEC-31-05' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, expectPage({ kind: 'metaContent', value: 'Team meeting' })])), ['missing_field $.steps[1].assert.name']);
});

test('canonicalUrl takes text, also of another origin since it is compared and never visited', { criterion: 'AC-SPEC-31-05' }, () => {
  for (const value of [`${ORIGIN}/events/team-meeting`, 'https://www.example.com/events/team-meeting']) {
    const step = expectPage({ kind: 'canonicalUrl', value });
    assert.deepEqual(parsedStep(accepted(parsePlan, planOf([OPEN_ORDERS, step])), 1), step, value);
  }
});

test('canonicalUrl of script-like text is refused as unsafe_text', { criterion: 'AC-SPEC-31-05' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, expectPage({ kind: 'canonicalUrl', value: 'javascript:alert(1)' })])), ['unsafe_text $.steps[1].assert.value']);
});

test('metaContent and canonicalUrl are page assertions: on an element they are refused', { criterion: 'AC-SPEC-31-05' }, () => {
  for (const assertion of [{ kind: 'metaContent', name: 'og:title', value: 'Team meeting' }, { kind: 'canonicalUrl', value: `${ORIGIN}/events` }]) {
    assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, expectOn(GUIDE_LINK, assertion)])), ['unknown_value $.steps[1].assert.kind'], assertion.kind);
  }
});

// ---- Downloads ------------------------------------------------------------------------------------

const DOWNLOAD_CHECKS: readonly JsonRecord[] = [
  { kind: 'fileNameEquals', value: 'projects.csv' },
  { kind: 'mediaTypeEquals', value: 'text/csv' },
  { kind: 'sizeAtLeast', value: 1 },
  { kind: 'sizeAtMost', value: 65_536 },
  { kind: 'contentContains', value: 'Website relaunch' },
  { kind: 'contentExcludes', value: 'Archived pilot' },
];

test('a download step and each download check after it are accepted and kept as written', { criterion: 'AC-SPEC-31-06' }, () => {
  const steps = [OPEN_ORDERS, download('project-list'), ...DOWNLOAD_CHECKS.map((check) => expectDownload('project-list', check))];
  const plan = accepted(parsePlan, planOf(steps));
  steps.forEach((step, index) => assert.deepEqual(parsedStep(plan, index), step, `step ${index}`));
});

test('fileNameEquals and the content checks take a run value; mediaTypeEquals does not', { criterion: 'AC-SPEC-31-06' }, () => {
  const values = { exportTitle: { kind: 'uniqueText', prefix: 'export' } };
  for (const kind of ['fileNameEquals', 'contentContains', 'contentExcludes']) {
    accepted(parsePlan, planOf([OPEN_ORDERS, download('project-list'), expectDownload('project-list', { kind, value: reference('exportTitle') })], { values }));
  }
  const errors = rejection(parsePlan, planOf([OPEN_ORDERS, download('project-list'), expectDownload('project-list', { kind: 'mediaTypeEquals', value: reference('exportTitle') })], { values }));
  assert.deepEqual(errors, ['wrong_type $.steps[2].assert.value']);
});

test('sizeAtLeast of 0 is refused, since an empty file proves nothing; 1 is accepted', { criterion: 'AC-SPEC-31-06' }, () => {
  const errors = rejection(parsePlan, planOf([OPEN_ORDERS, download('project-list'), expectDownload('project-list', { kind: 'sizeAtLeast', value: 0 })]));
  assert.deepEqual(errors.map((error) => error.split(' ')[1]), ['$.steps[2].assert.value']);
  accepted(parsePlan, planOf([OPEN_ORDERS, download('project-list'), expectDownload('project-list', { kind: 'sizeAtLeast', value: 1 })]));
});

test('a size that is not a whole number of bytes, or is negative, is refused at the value', { criterion: 'AC-SPEC-31-06' }, () => {
  for (const kind of ['sizeAtLeast', 'sizeAtMost']) {
    for (const value of [-1, 2.5, '100', null]) {
      const errors = rejection(parsePlan, planOf([OPEN_ORDERS, download('project-list'), expectDownload('project-list', { kind, value })]));
      assert.deepEqual(errors.map((error) => error.split(' ')[1]), ['$.steps[2].assert.value'], `${kind} ${JSON.stringify(value)}`);
    }
  }
});

test('a download check the language does not have, such as a page count, is refused at the kind', { criterion: 'AC-SPEC-31-06' }, () => {
  const errors = rejection(parsePlan, planOf([OPEN_ORDERS, download('project-list'), expectDownload('project-list', { kind: 'pageCountEquals', value: 3 })]));
  assert.deepEqual(errors, ['unknown_value $.steps[2].assert.kind']);
});

test('download names are lowercase letters, digits and hyphens, 1 to 64 long, starting with a letter or digit', { criterion: 'AC-SPEC-31-06' }, () => {
  for (const name of ['report', 'r', '2026-export', `a${'b'.repeat(63)}`]) {
    accepted(parsePlan, planOf([OPEN_ORDERS, download(name), expectDownload(name, { kind: 'sizeAtLeast', value: 1 })]));
  }
  for (const name of ['', 'Report', '-report', 'project_list', 'project list', '../report', 'report.csv', `a${'b'.repeat(64)}`]) {
    const errors = rejection(parsePlan, planOf([OPEN_ORDERS, download(name)]));
    assert.deepEqual(errors.map((error) => error.split(' ')[1]), ['$.steps[1].name'], JSON.stringify(name));
  }
});

test('a download name and the name an expectDownload checks are plain text, never a run value', { criterion: 'AC-SPEC-31-06' }, () => {
  const values = { exportName: { kind: 'uniqueText', prefix: 'export' } };
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, download(reference('exportName'))], { values })), ['wrong_type $.steps[1].name']);
  const errors = rejection(parsePlan, planOf([OPEN_ORDERS, download('project-list'), expectDownload(reference('exportName'), { kind: 'sizeAtLeast', value: 1 })], { values }));
  assert.deepEqual(errors, ['wrong_type $.steps[2].download']);
});

test('a download step needs a locator, and takes no other field', { criterion: 'AC-SPEC-31-06' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, { type: 'download', name: 'project-list' }])), ['missing_field $.steps[1].locator']);
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, { ...download('project-list'), path: '/tmp/projects.csv' }])), ['unknown_field $.steps[1].path']);
});

// expectDownload is an assertion step: it counts against a vacuous plan and needs a criterion id.
test('a plan whose only check is an expectDownload is accepted', { criterion: 'AC-SPEC-31-06' }, () => {
  const plan = { ...planOf([]), steps: [OPEN_ORDERS, download('project-list'), expectDownload('project-list', { kind: 'sizeAtLeast', value: 1 })] };
  accepted(parsePlan, plan);
});

test('an expectDownload without a criterion id is refused as vacuous', { criterion: 'AC-SPEC-31-06' }, () => {
  const { criterionId: _removed, ...untraced } = expectDownload('project-list', { kind: 'sizeAtLeast', value: 1 });
  const errors = rejection(parsePlan, planOf([OPEN_ORDERS, download('project-list'), untraced]));
  assert.ok(errors.length > 0 && errors.every((error) => error.startsWith('vacuous $.steps[2]')), JSON.stringify(errors));
});

// ---- Download names are defined before use, and only once -------------------------------------------

test('an expectDownload naming a download no step defines is refused with undefined_value at the name', { criterion: 'AC-SPEC-31-13' }, () => {
  const plan = planOf([OPEN_ORDERS, download('project-list'), expectDownload('invoice-list', { kind: 'sizeAtLeast', value: 1 })]);
  assert.deepEqual(rejection(parsePlan, plan), ['undefined_value $.steps[2].download']);
});

test('an expectDownload before the download step that defines its name is refused with undefined_value', { criterion: 'AC-SPEC-31-13' }, () => {
  const plan = planOf([OPEN_ORDERS, expectDownload('project-list', { kind: 'sizeAtLeast', value: 1 }), download('project-list')]);
  assert.deepEqual(rejection(parsePlan, plan), ['undefined_value $.steps[1].download']);
});

test('an expectDownload in a plan with no download step at all is refused with undefined_value', { criterion: 'AC-SPEC-31-13' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, expectDownload('project-list', { kind: 'sizeAtLeast', value: 1 })])), ['undefined_value $.steps[1].download']);
});

test('the same download name defined twice is refused as duplicate', { criterion: 'AC-SPEC-31-13' }, () => {
  const errors = rejection(parsePlan, planOf([OPEN_ORDERS, download('project-list'), download('project-list', label('Export again'))]));
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['duplicate']);
});

// Counter-example: the same check after its download, and two checks of two downloads, are accepted.
test('an expectDownload after its download is accepted, and each of two downloads may be checked', { criterion: 'AC-SPEC-31-13' }, () => {
  accepted(parsePlan, planOf([OPEN_ORDERS, download('project-list'), expectDownload('project-list', { kind: 'sizeAtLeast', value: 1 })]));
  accepted(parsePlan, planOf([
    OPEN_ORDERS, download('project-list'), download('invoice-list', label('Invoices')),
    expectDownload('invoice-list', { kind: 'sizeAtLeast', value: 1 }), expectDownload('project-list', { kind: 'sizeAtLeast', value: 1 }),
  ]));
});

test('an undefined download name is not echoed in the error', { criterion: 'AC-SPEC-31-13' }, () => {
  const parsed = parsePlan(planOf([OPEN_ORDERS, expectDownload('private-marker-q7zx', { kind: 'sizeAtLeast', value: 1 })]));
  assert.deepEqual(parsed.ok ? [] : parsed.error.map((error) => error.code), ['undefined_value']);
  assert.ok(!JSON.stringify(parsed).includes('private-marker-q7zx'), JSON.stringify(parsed));
});

// ---- A second tab ---------------------------------------------------------------------------------

test('a newTab at the top level, with a URL or a path template, is accepted and kept as written', { criterion: 'AC-SPEC-31-12' }, () => {
  for (const url of ['/account', `${ORIGIN}/account`, { segments: ['account'] }]) {
    const step = newTab(url, [CLOSING_CHECK]);
    assert.deepEqual(parsedStep(accepted(parsePlan, planOf([OPEN_ORDERS, step])), 1), step, JSON.stringify(url));
  }
});

test('a newTab may hold frames, whose depth counts from the tab', { criterion: 'AC-SPEC-31-12' }, () => {
  const shallow = parserFor({}, { maximumFrameDepth: 2 });
  accepted(shallow, planOf([OPEN_ORDERS, newTab('/account', [frame([frame([CLOSING_CHECK])])])]));
  const errors = rejection(shallow, planOf([OPEN_ORDERS, newTab('/account', [frame([frame([frame([CLOSING_CHECK])])])])]));
  assert.deepEqual(errors.map((error) => error.split(' ')[0]), ['too_large']);
});

// The path of a misplaced step: the step itself, or its type field, as unknown_step reports it.
function assertMisplacedAt(errors: readonly string[], stepPath: string): void {
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.ok([`misplaced_step ${stepPath}`, `misplaced_step ${stepPath}.type`].includes(errors[0] ?? ''), JSON.stringify(errors));
}

test('a newTab inside a frame is refused with misplaced_step at the newTab', { criterion: 'AC-SPEC-31-12' }, () => {
  assertMisplacedAt(rejection(parsePlan, planOf([OPEN_ORDERS, frame([newTab('/account'), CLOSING_CHECK])])), '$.steps[1].steps[0]');
});

test('a newTab inside another newTab is refused with misplaced_step at the inner one', { criterion: 'AC-SPEC-31-12' }, () => {
  assertMisplacedAt(rejection(parsePlan, planOf([OPEN_ORDERS, newTab('/account', [CLOSING_CHECK, newTab('/orders')])])), '$.steps[1].steps[1]');
});

test('a newTab inside a frame inside a newTab is refused with misplaced_step', { criterion: 'AC-SPEC-31-12' }, () => {
  assertMisplacedAt(rejection(parsePlan, planOf([OPEN_ORDERS, newTab('/account', [frame([newTab('/orders'), CLOSING_CHECK])])])), '$.steps[1].steps[0].steps[0]');
});

test('a newTab whose URL is not on the allow-list is refused with origin_not_allowed at the URL', { criterion: 'AC-SPEC-31-12' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, newTab('https://evil.example/collect')])), ['origin_not_allowed $.steps[1].url']);
});

test('a navigate inside a newTab to an origin not on the allow-list is refused as at the top level', { criterion: 'AC-SPEC-31-12' }, () => {
  const errors = rejection(parsePlan, planOf([OPEN_ORDERS, newTab('/account', [navigate('https://evil.example/collect'), CLOSING_CHECK])]));
  assert.deepEqual(errors, ['origin_not_allowed $.steps[1].steps[0].url']);
});

test('a newTab URL with another scheme or script-like text is refused at the URL', { criterion: 'AC-SPEC-31-12' }, () => {
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)']) {
    const errors = rejection(parsePlan, planOf([OPEN_ORDERS, newTab(url)]));
    assert.deepEqual(errors.map((error) => error.split(' ')[1]), ['$.steps[1].url'], url);
  }
});

test('a newTab takes no other field, such as a window name or a popup flag', { criterion: 'AC-SPEC-31-12' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, { ...newTab('/account'), popup: true }])), ['unknown_field $.steps[1].popup']);
});

test('a plan with a misplaced or off-list newTab is refused before any driver is touched', { criterion: 'AC-SPEC-31-12' }, async () => {
  let calls = 0;
  const spy: BrowserDriver = {
    info: { id: 'playwright', version: 'spy', protocol: 'none' },
    supports() { calls++; return { ok: true, value: true }; },
    async open() { calls++; return failure({ reason: 'launch-failed', detail: 'the spy never launches' }); },
  };
  const events = memoryRunEventSink();
  const ports = { drivers: new Map([['playwright', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), events };
  const base = { project: projectWith(), baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() } };
  for (const plan of [planOf([OPEN_ORDERS, frame([newTab('/account'), CLOSING_CHECK])]), planOf([OPEN_ORDERS, newTab('https://evil.example/collect')])]) {
    const outcome = await runUntrusted(plan, parsePlan, base, ports);
    assert.ok(!Array.isArray(outcome) && 'errors' in outcome, JSON.stringify(outcome));
  }
  assert.equal(calls, 0, 'no driver method was called');
  assert.equal(events.read().length, 0, 'nothing was logged');

  // Positive control: a plan with a valid newTab does reach the driver.
  await runUntrusted(planOf([OPEN_ORDERS, newTab('/account')]), parsePlan, base, ports);
  assert.ok(calls > 0, 'a valid plan reaches the driver, so the zero above is meaningful');
});
