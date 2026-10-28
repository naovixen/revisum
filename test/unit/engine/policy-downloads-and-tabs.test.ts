// The policy gate treats a download step as the click it is: the static check denies a download
// whose control the plan names after an irreversible action, and the runtime guard denies one
// whose resolved control is so named, or has no name, or is a link to a destructive path. Inside
// a newTab the gate applies exactly as in the first tab: each plan below gets the same decision
// whether its steps run in the first tab or in a second one. That a denied download sends no input
// event, and that egress control holds in the tab's browser, come with the CDP driver.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ALLOWED, DESTRUCTIVE_PATH, ENGLISH, OPEN_ACCOUNT_PAGE, PRODUCTION_ORIGIN, comparable, decideOn, denied, element, localeOf,
  parsedPlan, planOf, role, stepAt, testGate, testId, type JsonRecord,
} from './policy-examples.ts';

const NEW_VERSION = '1.2';
const newerPlan = (steps: readonly unknown[]): JsonRecord => ({ ...planOf(steps), version: NEW_VERSION });
const download = (locator: JsonRecord): JsonRecord => ({ type: 'download', name: 'account-export', locator });
const newTab = (url: string, steps: readonly unknown[]): JsonRecord => ({ type: 'newTab', url, steps });
const TAB_CHECK: JsonRecord = {
  type: 'expect', locator: { by: 'role', role: 'heading', name: 'Your account' }, assert: { kind: 'visible' }, criterionId: 'account.tab-shown',
};

// ---- The runtime guard on a download ------------------------------------------------------------

// Parses [open the account page, a download by test id], then guards the download as a driver
// would once it has resolved the control.
async function guardDownload(resolved: ReturnType<typeof element>) {
  const { gate, project } = await testGate();
  const plan = parsedPlan(newerPlan([OPEN_ACCOUNT_PAGE, download(testId('export-control'))]));
  return gate.guardAction(stepAt(plan, 1), 1, resolved, null, localeOf(project, ENGLISH));
}

test('a download whose control is named "Delete account" is denied by the runtime guard as irreversible-action', { criterion: 'AC-SPEC-31-10' }, async () => {
  assert.deepEqual(await guardDownload(element({ role: 'button', name: 'Delete account' })), denied('irreversible-action', 1));
});

test('a download whose control is named after a project pattern, "Archive and export", is denied too', { criterion: 'AC-SPEC-31-10' }, async () => {
  assert.deepEqual(await guardDownload(element({ role: 'button', name: 'Archive and export' })), denied('irreversible-action', 1));
});

test('a download whose control has no accessible name is denied as unnamed-control', { criterion: 'AC-SPEC-31-10' }, async () => {
  assert.deepEqual(await guardDownload(element({ role: 'button', name: null })), denied('unnamed-control', 1));
});

test('a download from a link to a destructive path is denied as destructive-navigation', { criterion: 'AC-SPEC-31-10' }, async () => {
  const link = element({ role: 'link', name: 'Export', linkUrl: `http://127.0.0.1:4173${DESTRUCTIVE_PATH}/export.csv` });
  assert.deepEqual(await guardDownload(link), denied('destructive-navigation', 1));
});

// Counter-example: the same download from a harmless control is allowed.
test('a download whose control is named "Export CSV" is allowed', { criterion: 'AC-SPEC-31-10' }, async () => {
  assert.deepEqual(await guardDownload(element({ role: 'button', name: 'Export CSV' })), ALLOWED);
});

// ---- The static check on a download -------------------------------------------------------------

test('the static check denies a download whose locator names "Delete account", as it denies such a click', { criterion: 'AC-SPEC-31-10' }, async () => {
  const tested = await testGate();
  const asDownload = decideOn(tested, parsedPlan(newerPlan([OPEN_ACCOUNT_PAGE, download(role('button', 'Delete account'))])));
  const asClick = decideOn(tested, parsedPlan(newerPlan([OPEN_ACCOUNT_PAGE, { type: 'click', locator: role('button', 'Delete account') }])));
  assert.deepEqual(comparable(asDownload), { kind: 'deny', rule: 'irreversible-action', stepIndex: 1 });
  assert.deepEqual(comparable(asDownload), comparable(asClick));
});

test('the static check allows a download whose locator names "Export CSV"', { criterion: 'AC-SPEC-31-10' }, async () => {
  const tested = await testGate();
  assert.deepEqual(comparable(decideOn(tested, parsedPlan(newerPlan([OPEN_ACCOUNT_PAGE, download(role('button', 'Export CSV'))])))), { kind: 'allow' });
});

// ---- The gate inside a second tab ---------------------------------------------------------------

// `firstTabIndex` is the index of the denied step when the same steps run in the first tab.
type TabCase = {
  readonly name: string; readonly url: string; readonly steps: readonly JsonRecord[]; readonly rule: string; readonly firstTabIndex: number;
};

// Each case's steps run either inside a newTab opened at the URL, or in the first tab after a
// navigate to it. In a tab, a denial names the newTab's own top-level index, 1, as a denial
// inside a frame names the frame's.
const TAB_CASES: readonly TabCase[] = [
  { name: 'a tab opened on a destructive path', url: DESTRUCTIVE_PATH, steps: [TAB_CHECK], rule: 'destructive-navigation', firstTabIndex: 1 },
  { name: 'a tab opened on a production origin by a proposal', url: `${PRODUCTION_ORIGIN}/account`, steps: [TAB_CHECK], rule: 'production-origin', firstTabIndex: 1 },
  { name: 'a click on "Delete account" in the tab', url: '/account', steps: [{ type: 'click', locator: role('button', 'Delete account') }, TAB_CHECK], rule: 'irreversible-action', firstTabIndex: 2 },
  { name: 'a download from "Delete account" in the tab', url: '/account', steps: [download(role('button', 'Delete account')), TAB_CHECK], rule: 'irreversible-action', firstTabIndex: 2 },
  { name: 'a navigation to a destructive path in the tab', url: '/account', steps: [{ type: 'navigate', url: DESTRUCTIVE_PATH }, TAB_CHECK], rule: 'destructive-navigation', firstTabIndex: 2 },
];

for (const tabCase of TAB_CASES) {
  test(`${tabCase.name} is denied as ${tabCase.rule}, exactly as in the first tab`, { criterion: 'AC-SPEC-31-11' }, async () => {
    const tested = await testGate();
    const inTab = decideOn(tested, parsedPlan(newerPlan([OPEN_ACCOUNT_PAGE, newTab(tabCase.url, tabCase.steps)])));
    const inFirstTab = decideOn(tested, parsedPlan(newerPlan([OPEN_ACCOUNT_PAGE, { type: 'navigate', url: tabCase.url }, ...tabCase.steps])));
    assert.deepEqual(comparable(inTab), { kind: 'deny', rule: tabCase.rule, stepIndex: 1 });
    assert.deepEqual(comparable(inFirstTab), { kind: 'deny', rule: tabCase.rule, stepIndex: tabCase.firstTabIndex });
  });
}

// Counter-example: a harmless tab is allowed in both forms.
test('a tab opened on the account page that only checks it is allowed, as in the first tab', { criterion: 'AC-SPEC-31-11' }, async () => {
  const tested = await testGate();
  assert.deepEqual(comparable(decideOn(tested, parsedPlan(newerPlan([OPEN_ACCOUNT_PAGE, newTab('/account', [TAB_CHECK])])))), { kind: 'allow' });
  assert.deepEqual(comparable(decideOn(tested, parsedPlan(newerPlan([OPEN_ACCOUNT_PAGE, { type: 'navigate', url: '/account' }, TAB_CHECK])))), { kind: 'allow' });
});
