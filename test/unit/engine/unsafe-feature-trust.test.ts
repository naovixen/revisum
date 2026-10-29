// Unsafe features are enabled only in the trusted project file, and trusted by where it comes from.
// A change that turns a feature on, or widens one, in its own project.json, or edits a script
// under plans/scripts/, runs against the protected-branch versions and raises changed-with-code
// for each such file. So a plan in that change that uses the new feature is refused with
// unsafe_feature_disabled: an agent cannot enable an escape hatch and use it in one change.
// The fixture is fixtures/unsafe-features/hostile-change.json, on the solo approval repository.
// See docs/specs/SPEC-36-unsafe-plan-features.md and docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { planParser } from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';
import {
  PROJECT_PATH, eventsOfKind, loadForChange, memoryEventSink, withRepository, type FixtureRepository,
} from './approval-repositories.ts';
import { disabledPaths, errorsOf, parsedProject, type ParsePlan } from './unsafe-feature-examples.ts';
import { INLINE_SOURCE, xpath, type JsonRecord } from './unsafe-feature-steps.ts';

type HostileChange = { readonly description: string; readonly changedFiles: readonly string[]; readonly workingCopy: Record<string, unknown> };

const hostileChange = (): HostileChange => JSON.parse(readFileSync(join(FIXTURES, 'unsafe-features', 'hostile-change.json'), 'utf8'));

const SCRIPT_PATH = 'plans/scripts/read-cart.js';
const PLAN_IN_CHANGE = 'plans/cart.json';

// The project.json the hostile change writes, and the plan it adds.
const changedProject = (): JsonRecord => structuredClone(hostileChange().workingCopy[PROJECT_PATH]) as JsonRecord;
const changedPlan = (): JsonRecord => structuredClone(hostileChange().workingCopy[PLAN_IN_CHANGE]) as JsonRecord;
const unsafeSectionOf = (project: JsonRecord): JsonRecord => project['unsafeFeatures'] as JsonRecord;

const applyHostileChange = (fixture: FixtureRepository): void => { Object.assign(fixture.workingCopy, hostileChange().workingCopy); };

// A plan of the change's with `steps` between its navigation and its CSS check, in place of its
// page-script check. Step 1 is the first of `steps`.
const planWith = (steps: readonly JsonRecord[]): JsonRecord => {
  const plan = changedPlan();
  const [navigation, cssCheck] = plan['steps'] as JsonRecord[];
  return { ...plan, steps: [navigation, ...steps, cssCheck] };
};
const XPATH_STEP: JsonRecord = { type: 'expect', locator: xpath('//main//li[2]'), assert: { kind: 'visible' }, criterionId: 'cart.second-item' };
const INLINE_STEP: JsonRecord = {
  type: 'expectScript', script: { inline: { source: INLINE_SOURCE, effect: 'read', fields: { blockCount: '/blocks' } } }, arguments: {},
  field: 'blockCount', assert: { kind: 'equals', value: '2' }, criterionId: 'editor.two-blocks',
};

// Loads project.json for a change that edits `changedFiles`. The plan parser is built from the
// protected branch's project.json, and the loaded project's unsafeFeatures section must be that
// one: what core trusts is what the parser enforces.
async function loadedFor(fixtureEdit: (fixture: FixtureRepository) => void, changedFiles: readonly string[] = hostileChange().changedFiles) {
  let outcome: { readonly parse: ParsePlan; readonly reviewPaths: readonly string[]; readonly eventCount: number } | undefined;
  await withRepository('solo', async (repository) => {
    const events = memoryEventSink();
    const versionControl = repository.versionControl();
    const loaded = await loadForChange(versionControl, changedFiles, events);
    assert.ok(loaded.ok, JSON.stringify(loaded));
    const protectedFile = await versionControl.protectedFile(PROJECT_PATH);
    assert.ok(protectedFile.ok, 'the protected branch has no project.json');
    const protectedProject = parsedProject(JSON.parse(new TextDecoder().decode(protectedFile.value.bytes)));
    assert.deepEqual(loaded.value.project.unsafeFeatures, protectedProject.unsafeFeatures, 'the loaded project holds another unsafeFeatures section than the protected branch');
    outcome = {
      parse: planParser(protectedProject),
      reviewPaths: loaded.value.reviewItems.map((item) => { assert.equal(item.code, 'changed-with-code'); return item.path; }),
      eventCount: eventsOfKind(events, 'trusted.changed-with-code').length,
    };
  }, fixtureEdit);
  assert.ok(outcome !== undefined);
  return outcome;
}

// ---- A change that turns features on ---------------------------------------------------------------

test('a change that turns on CSS locators and page scripts in its own project.json is refused its own CSS plan with unsafe_feature_disabled', { criterion: 'AC-SPEC-36-04' }, async () => {
  const { parse } = await loadedFor(applyHostileChange);
  const errors = errorsOf(parse, changedPlan());
  assert.deepEqual(disabledPaths(errors), ['$.steps[1].locator.by', '$.steps[2].type']);
});

test('the change\'s edits of project.json, its plan and its script each raise one changed-with-code item and event; its app code raises none', { criterion: 'AC-SPEC-36-04' }, async () => {
  const { reviewPaths, eventCount } = await loadedFor(applyHostileChange);
  assert.deepEqual([...reviewPaths].sort(), [PLAN_IN_CHANGE, SCRIPT_PATH, PROJECT_PATH].sort());
  assert.equal(eventCount, 3);
});

test('a change that edits only the script under plans/scripts/ raises changed-with-code naming it', { criterion: 'AC-SPEC-36-04' }, async () => {
  const { reviewPaths } = await loadedFor((fixture) => {
    fixture.protectedFiles[SCRIPT_PATH] = '() => ({ count: window.cartStore.items.length })\n';
    fixture.workingCopy[SCRIPT_PATH] = hostileChange().workingCopy[SCRIPT_PATH];
  }, [SCRIPT_PATH, 'src/cart.ts']);
  assert.deepEqual(reviewPaths, [SCRIPT_PATH]);
});

// Counter-example: the same section, once on the protected branch, lets the same plan parse, so
// the refusal above comes from where the section was read.
test('the same unsafeFeatures section, once on the protected branch, lets the change\'s plan parse', { criterion: 'AC-SPEC-36-04' }, async () => {
  const { parse } = await loadedFor((fixture) => { fixture.protectedFiles[PROJECT_PATH] = changedProject(); }, []);
  const parsed = parse(changedPlan());
  assert.ok(parsed.ok, JSON.stringify(parsed));
});

// ---- A change that widens a feature -----------------------------------------------------------------

// The protected branch already enables what the hostile change enables.
const protectChangedProject = (fixture: FixtureRepository): void => { fixture.protectedFiles[PROJECT_PATH] = changedProject(); };

test('a change that adds XPath locators to protected CSS locators is refused its XPath plan, while its CSS plan still parses', { criterion: 'AC-SPEC-36-04' }, async () => {
  const widened = changedProject();
  unsafeSectionOf(widened)['xpathLocators'] = true;
  const { parse, reviewPaths } = await loadedFor((fixture) => {
    protectChangedProject(fixture);
    fixture.workingCopy[PROJECT_PATH] = widened;
  }, [PROJECT_PATH]);
  assert.deepEqual(reviewPaths, [PROJECT_PATH]);
  assert.deepEqual(disabledPaths(errorsOf(parse, planWith([XPATH_STEP]))), ['$.steps[1].locator.by']);
  assert.ok(parse(changedPlan()).ok, 'the protected CSS and page-script features were lost');
});

test('a change that turns inline scripts on over protected page scripts is refused its inline script at .script.inline', { criterion: 'AC-SPEC-36-04' }, async () => {
  const protectedProject = changedProject();
  (unsafeSectionOf(protectedProject)['pageScripts'] as JsonRecord)['allowInline'] = false;
  const { parse, reviewPaths } = await loadedFor((fixture) => {
    fixture.protectedFiles[PROJECT_PATH] = protectedProject;
    fixture.workingCopy[PROJECT_PATH] = changedProject();
  }, [PROJECT_PATH]);
  assert.deepEqual(reviewPaths, [PROJECT_PATH]);
  assert.deepEqual(disabledPaths(errorsOf(parse, planWith([INLINE_STEP]))), ['$.steps[1].script.inline']);
});

test('a change that declares a new script in its own project.json is refused a plan naming it, as an undeclared script', { criterion: 'AC-SPEC-36-04' }, async () => {
  const widened = changedProject();
  const scripts = (unsafeSectionOf(widened)['pageScripts'] as JsonRecord)['scripts'] as JsonRecord;
  scripts['readCookies'] = { file: 'plans/scripts/read-cookies.js', parameters: {}, effect: 'read', fields: { cookies: '/cookies' }, allowInProposals: true };
  const { parse } = await loadedFor((fixture) => {
    protectChangedProject(fixture);
    fixture.workingCopy[PROJECT_PATH] = widened;
    fixture.workingCopy['plans/scripts/read-cookies.js'] = '() => ({ cookies: document.cookie })\n';
  }, [PROJECT_PATH, 'plans/scripts/read-cookies.js']);
  const plan = planWith([{ type: 'evaluate', script: 'readCookies', arguments: {} }]);
  const errors = errorsOf(parse, plan).map((error) => `${error.code} ${error.path}`);
  assert.deepEqual(errors, ['unknown_value $.steps[1].script']);
});
