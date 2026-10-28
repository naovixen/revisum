// The page checks, downloads and second tab are 1.2 features. A plan declaring "1.1" that uses one
// is refused with exactly the code and path a 1.1 parser gives, and declared as "1.2" the same
// plan is accepted. The expected codes were recorded from the parser before any of these features
// existed, when it still read them as a 1.1 parser does.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md and
// docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultParser, signupPlan, stepsOf } from './plan-examples.ts';
import { NEW_VERSION, PREVIOUS_VERSION, type JsonRecord } from './run-value-examples.ts';

const parsePlan = defaultParser();

const TAB: JsonRecord = { by: 'role', role: 'tab', name: 'Billing' };
const LINK: JsonRecord = { by: 'role', role: 'link', name: 'Export' };

// The sign-up plan, which declares "1.1", with `added` inserted from step 1 on.
const previousPlanWith = (...added: JsonRecord[]): JsonRecord => {
  const steps = [...stepsOf(signupPlan())];
  steps.splice(1, 0, ...added);
  return { ...signupPlan(), steps };
};

type PreviousCase = { readonly feature: string; readonly plan: () => JsonRecord; readonly errors: readonly string[] };

const DOWNLOAD: JsonRecord = { type: 'download', name: 'report', locator: LINK };

const PREVIOUS_CASES: readonly PreviousCase[] = [
  ...['selected', 'unselected', 'expanded', 'collapsed', 'pressed', 'unpressed', 'current'].map((kind): PreviousCase => ({
    feature: `the state check "${kind}"`,
    plan: () => previousPlanWith({ type: 'expect', locator: TAB, assert: { kind }, criterionId: 'settings.tab-state' }),
    errors: ['unknown_value $.steps[1].assert.kind'],
  })),
  {
    feature: 'a link-target check',
    plan: () => previousPlanWith({ type: 'expect', locator: LINK, assert: { kind: 'hrefEquals', value: 'http://127.0.0.1:4173/export' }, criterionId: 'export.link' }),
    errors: ['unknown_value $.steps[1].assert.kind'],
  },
  {
    feature: 'a meta tag check',
    plan: () => previousPlanWith({ type: 'expectPage', assert: { kind: 'metaContent', name: 'og:title', value: 'Sign up' }, criterionId: 'signup.sharing-title' }),
    errors: ['unknown_value $.steps[1].assert.kind'],
  },
  {
    feature: 'a canonical URL check',
    plan: () => previousPlanWith({ type: 'expectPage', assert: { kind: 'canonicalUrl', value: 'http://127.0.0.1:4173/signup' }, criterionId: 'signup.canonical' }),
    errors: ['unknown_value $.steps[1].assert.kind'],
  },
  {
    feature: 'a server-rendered view',
    plan: () => previousPlanWith({ type: 'navigate', url: '/signup', scripts: 'disabled' }),
    errors: ['unknown_field $.steps[1].scripts'],
  },
  { feature: 'a download step', plan: () => previousPlanWith(DOWNLOAD), errors: ['unknown_step $.steps[1].type'] },
  {
    // The check names a download, so the download comes first; without it a 1.2 plan is refused too.
    feature: 'a download check',
    plan: () => previousPlanWith(DOWNLOAD, { type: 'expectDownload', download: 'report', assert: { kind: 'sizeAtLeast', value: 1 }, criterionId: 'export.file' }),
    errors: ['unknown_step $.steps[1].type', 'unknown_step $.steps[2].type'],
  },
  {
    feature: 'a second tab',
    plan: () => previousPlanWith({ type: 'newTab', url: '/account', steps: [{ type: 'expect', locator: TAB, assert: { kind: 'visible' }, criterionId: 'account.tab' }] }),
    errors: ['unknown_step $.steps[1].type'],
  },
];

for (const previous of PREVIOUS_CASES) {
  test(`a plan declaring "${PREVIOUS_VERSION}" that uses ${previous.feature} is refused as a 1.1 parser refuses it`, { criterion: 'AC-SPEC-30-01' }, () => {
    const parsed = parsePlan(previous.plan());
    assert.equal(parsed.ok, false, 'the plan was accepted');
    assert.deepEqual(parsed.ok ? [] : parsed.error.map((error) => `${error.code} ${error.path}`), previous.errors);
  });

  // Counter-example: the same plan declared as "1.2" is accepted, so the declared version is what
  // decides the grammar.
  test(`the same plan with ${previous.feature}, declared as "${NEW_VERSION}", is accepted`, { criterion: 'AC-SPEC-30-01' }, () => {
    const parsed = parsePlan({ ...previous.plan(), version: NEW_VERSION });
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.equal(parsed.value.version, NEW_VERSION);
  });
}

test(`a download and its check, declared as "${PREVIOUS_VERSION}", are both refused as unknown steps`,{ criterion: 'AC-SPEC-30-01' }, () => {
  const plan = previousPlanWith(DOWNLOAD, { type: 'expectDownload', download: 'report', assert: { kind: 'sizeAtLeast', value: 1 }, criterionId: 'export.file' });
  const parsed = parsePlan(plan);
  assert.deepEqual(parsed.ok ? [] : parsed.error.map((error) => `${error.code} ${error.path}`), ['unknown_step $.steps[1].type', 'unknown_step $.steps[2].type']);
});
