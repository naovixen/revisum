// What an unsafe plan says about itself. The parser's plan yields the sorted list of unsafe
// features it uses (unsafeFeaturesOf), empty for a closed plan. A run of an unsafe plan carries
// that list in its result, which is the `unsafe` label, and a guarantee statement at the `host`
// level that loses exactly the guarantees the spec's table gives for those features, each with the
// feature that lost it. The statement is computed from the plan's features and the run's isolation
// alone, so two runs of one plan say the same. The manifest records the features and the sha256 of
// each named script's source and each command declaration the plan uses, so changing any of them
// changes the manifest hash.
// See docs/specs/SPEC-36-unsafe-plan-features.md and docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GUARANTEE_IDS } from '@revisum/engine';
import { goldenPlan, goldenPlanNames } from './plan-examples.ts';
import { OPEN_ORDERS, planOf, runPlan } from './run-value-examples.ts';
import {
  LOST_BY_FEATURE, acceptedBy, featuresOf, lostBy, lostIds, lostToFeatures, manifestOf, parserEnabling, reasonsFor, runUnsafePlan, statementFor,
} from './unsafe-feature-examples.ts';
import {
  ALL_FEATURES_PLAN, CART_COUNT_CHECK, CLASS_CHECK, CSS_CHECK, DATABASE_COMMANDS, FEATURES, FEATURE_EXAMPLES, INLINE_READ, OPEN_CART, ORDER_COUNT_CHECK, READ_CART,
  READ_CART_FILE, SCRIPT_SOURCES, SEED_EDITOR_FILE, STYLE_CHECK, XPATH_CHECK, unsafePlan, unsafeProjectFile, unsafeSection,
  type FeatureName, type JsonRecord,
} from './unsafe-feature-steps.ts';

const parseAll = parserEnabling(FEATURES);
const sha256Of = (text: string): string => createHash('sha256').update(text).digest('hex');
const SORTED_FEATURES = [...FEATURES].sort();

// ---- The features a plan uses -------------------------------------------------------------------------

test('every closed golden plan uses no unsafe feature, even under a project that enables all six', { criterion: 'AC-SPEC-36-16' }, () => {
  for (const name of goldenPlanNames()) {
    assert.deepEqual(featuresOf(acceptedBy(parseAll, goldenPlan(name))), [], name);
  }
});

// A plan whose only script is inline lists inline-page-script alone, not page-script.
for (const example of FEATURE_EXAMPLES) {
  test(`a plan using only ${example.feature} uses exactly that feature`, { criterion: 'AC-SPEC-36-16' }, () => {
    assert.deepEqual(featuresOf(acceptedBy(parseAll, unsafePlan(example.steps))), [example.feature]);
  });
}

test('a plan with a named and an inline script lists both page-script and inline-page-script', { criterion: 'AC-SPEC-36-16' }, () => {
  assert.deepEqual(featuresOf(acceptedBy(parseAll, unsafePlan([OPEN_CART, READ_CART, INLINE_READ]))), ['inline-page-script', 'page-script']);
});

test('the plan using all six lists all six, sorted', { criterion: 'AC-SPEC-36-16' }, () => {
  assert.deepEqual(featuresOf(acceptedBy(parseAll, ALL_FEATURES_PLAN())), SORTED_FEATURES);
});

test('a feature used several times is listed once, and the list is sorted whatever the plan\'s order', { criterion: 'AC-SPEC-36-16' }, () => {
  const plan = unsafePlan([OPEN_CART, XPATH_CHECK, STYLE_CHECK, CSS_CHECK, CLASS_CHECK, XPATH_CHECK]);
  assert.deepEqual(featuresOf(acceptedBy(parseAll, plan)), ['css-locator', 'dom-checks', 'xpath-locator']);
});

// ---- The guarantee statement ------------------------------------------------------------------------

for (const feature of FEATURES) {
  test(`with egress enforced, ${feature} loses exactly ${LOST_BY_FEATURE[feature].join(', ')}, each because of ${feature}`, { criterion: 'AC-SPEC-36-16' }, () => {
    const statement = statementFor([feature], true);
    assert.equal(statement.level, 'host');
    assert.deepEqual(lostIds(statement), [...LOST_BY_FEATURE[feature]].sort());
    for (const guarantee of LOST_BY_FEATURE[feature]) assert.deepEqual(reasonsFor(statement, guarantee), [feature], guarantee);
    assert.deepEqual([...statement.holds].sort(), GUARANTEE_IDS.filter((guarantee) => !LOST_BY_FEATURE[feature].includes(guarantee)).sort());
  });
}

// Counter-example: the same conditions with no unsafe feature keep every guarantee.
test('with egress enforced and no unsafe feature, a plan run keeps every guarantee at the isolated level', { criterion: 'AC-SPEC-36-16' }, () => {
  const statement = statementFor([], true);
  assert.equal(statement.level, 'isolated');
  assert.deepEqual(statement.lost, []);
});

test('with all six features, the lost guarantees are the union of the table\'s rows, each lost to a feature that loses it', { criterion: 'AC-SPEC-36-16' }, () => {
  const statement = statementFor(SORTED_FEATURES, true);
  assert.equal(statement.level, 'host');
  assert.deepEqual(lostIds(statement), lostBy(FEATURES));
  for (const guarantee of lostBy(FEATURES)) {
    const reasons = reasonsFor(statement, guarantee);
    assert.ok(reasons.length >= 1, guarantee);
    assert.ok(reasons.every((reason) => (FEATURES as readonly string[]).includes(reason) && LOST_BY_FEATURE[reason as FeatureName].includes(guarantee)), `${guarantee}: ${JSON.stringify(reasons)}`);
  }
});

test('egress control, ambient credentials and secret redaction hold whatever unsafe features a plan uses', { criterion: 'AC-SPEC-36-16' }, () => {
  const statement = statementFor(SORTED_FEATURES, true);
  for (const guarantee of ['egress-enforced', 'no-ambient-credentials', 'secrets-redacted'] as const) assert.ok(statement.holds.includes(guarantee), guarantee);
});

test('PII masking holds for every feature but page scripts', { criterion: 'AC-SPEC-36-16' }, () => {
  for (const feature of FEATURES) {
    const masked = statementFor([feature], true).holds.includes('pii-masked');
    assert.equal(masked, feature !== 'page-script' && feature !== 'inline-page-script', feature);
  }
});

// ---- Labels on the run result ---------------------------------------------------------------------------

// CSS, DOM checks, a page-script check and a database check: four features a proposal may run.
const FOUR_FEATURES_PLAN = (): JsonRecord => unsafePlan([OPEN_CART, CSS_CHECK, CLASS_CHECK, CART_COUNT_CHECK, ORDER_COUNT_CHECK]);
const FOUR_FEATURES: readonly FeatureName[] = ['css-locator', 'database-command', 'dom-checks', 'page-script'];

test('a run of a plan using CSS locators carries the unsafe label, naming css-locator, in its result JSON', { criterion: 'AC-SPEC-36-16' }, async () => {
  const { result } = await runUnsafePlan(unsafePlan([OPEN_CART, CSS_CHECK]));
  assert.deepEqual(result.unsafeFeatures, ['css-locator']);
  const written: JsonRecord = JSON.parse(JSON.stringify(result));
  assert.deepEqual(written['unsafeFeatures'], ['css-locator']);
});

test('that run is host level, and the only guarantee it loses to a feature is semantic-locators', { criterion: 'AC-SPEC-36-16' }, async () => {
  const { result } = await runUnsafePlan(unsafePlan([OPEN_CART, CSS_CHECK]));
  assert.equal(result.guarantees.level, 'host');
  assert.deepEqual(lostToFeatures(result.guarantees), ['semantic-locators']);
});

test('a run of a plan using four features names all four and loses exactly the table\'s guarantees on top of a closed run\'s', { criterion: 'AC-SPEC-36-16' }, async () => {
  const { result } = await runUnsafePlan(FOUR_FEATURES_PLAN());
  assert.deepEqual(result.unsafeFeatures, FOUR_FEATURES);
  assert.equal(result.guarantees.level, 'host');
  // A closed plan run on the host already loses the guarantees only the isolated runner gives.
  const closed = (await runPlan(planOf([OPEN_ORDERS]))).result.guarantees;
  assert.deepEqual(lostIds(result.guarantees), [...new Set([...lostIds(closed), ...lostBy(FOUR_FEATURES)])].sort());
  for (const guarantee of lostBy(FOUR_FEATURES).filter((lost) => !lostIds(closed).includes(lost))) {
    assert.ok(reasonsFor(result.guarantees, guarantee).every((reason) => (FOUR_FEATURES as readonly string[]).includes(reason)), guarantee);
  }
});

test('a run\'s statement is the gate\'s statement for the plan\'s features on the host, and nothing the run did', { criterion: 'AC-SPEC-36-16' }, async () => {
  // Plan runs are not yet inside the isolated runner, so egress is not enforced.
  for (const plan of [unsafePlan([OPEN_CART, CSS_CHECK]), FOUR_FEATURES_PLAN()]) {
    const { result } = await runUnsafePlan(plan);
    assert.deepEqual(result.guarantees, statementFor(result.unsafeFeatures ?? [], false));
  }
});

// Counter-example: a closed plan's run carries no unsafe label and the statement it had before.
test('a run of a closed plan carries no unsafe feature, and its statement is the closed one', { criterion: 'AC-SPEC-36-16' }, async () => {
  const { result } = await runPlan(planOf([OPEN_ORDERS]));
  // Absent, not an empty list, so a closed run's hashes stay as they were.
  assert.equal(Object.hasOwn(result, 'unsafeFeatures'), false);
  assert.equal(Object.hasOwn(manifestOf(result), 'unsafeFeatures'), false);
  assert.equal(Object.hasOwn(manifestOf(result), 'unsafeDeclarations'), false);
  assert.deepEqual(lostToFeatures(result.guarantees), []);
  assert.deepEqual(result.guarantees, statementFor([], false));
});

// ---- Two runs of one plan ------------------------------------------------------------------------------

test('two runs of one unsafe plan carry the same features, the same statement and the same hashes', { criterion: 'AC-SPEC-36-17' }, async () => {
  const first = (await runUnsafePlan(FOUR_FEATURES_PLAN())).result;
  const second = (await runUnsafePlan(FOUR_FEATURES_PLAN())).result;
  assert.deepEqual(second.unsafeFeatures, first.unsafeFeatures);
  assert.deepEqual(second.guarantees, first.guarantees);
  assert.equal(second.manifestHash, first.manifestHash);
  assert.equal(second.resultHash, first.resultHash);
});

// ---- The manifest ---------------------------------------------------------------------------------------

test('the manifest records the plan\'s unsafe features beside its plan hash', { criterion: 'AC-SPEC-36-17' }, async () => {
  const { result } = await runUnsafePlan(FOUR_FEATURES_PLAN());
  assert.deepEqual(manifestOf(result).unsafeFeatures, FOUR_FEATURES);
});

test('adding a feature to a plan changes the manifest\'s features and its hash', { criterion: 'AC-SPEC-36-17' }, async () => {
  const before = (await runUnsafePlan(unsafePlan([OPEN_CART, CSS_CHECK]))).result;
  const after = (await runUnsafePlan(unsafePlan([OPEN_CART, CSS_CHECK, CLASS_CHECK]))).result;
  assert.deepEqual(manifestOf(before).unsafeFeatures, ['css-locator']);
  assert.deepEqual(manifestOf(after).unsafeFeatures, ['css-locator', 'dom-checks']);
  assert.notEqual(after.manifestHash, before.manifestHash);
});

const SCRIPT_PLAN = (): JsonRecord => unsafePlan([OPEN_CART, CART_COUNT_CHECK]);

test('the manifest records the sha256 of the named script\'s source, by its declared name', { criterion: 'AC-SPEC-36-17' }, async () => {
  const { result } = await runUnsafePlan(SCRIPT_PLAN());
  const source = SCRIPT_SOURCES[READ_CART_FILE];
  assert.ok(source !== undefined);
  assert.deepEqual(manifestOf(result).unsafeDeclarations, [{ kind: 'script', name: 'readCart', sha256: sha256Of(source) }]);
});

test('one byte more in the named script\'s source changes the manifest hash, though the plan is the same', { criterion: 'AC-SPEC-36-17' }, async () => {
  const source = SCRIPT_SOURCES[READ_CART_FILE];
  assert.ok(source !== undefined);
  const before = (await runUnsafePlan(SCRIPT_PLAN())).result;
  const after = (await runUnsafePlan(SCRIPT_PLAN(), { scriptSources: { ...SCRIPT_SOURCES, [READ_CART_FILE]: `${source} ` } })).result;
  assert.equal(manifestOf(after).planHash, manifestOf(before).planHash);
  assert.notEqual(after.manifestHash, before.manifestHash);
});

// Counter-example: only declarations the plan uses are recorded.
test('a change to a script the plan does not use leaves the manifest hash as it was', { criterion: 'AC-SPEC-36-17' }, async () => {
  const before = (await runUnsafePlan(SCRIPT_PLAN())).result;
  const after = (await runUnsafePlan(SCRIPT_PLAN(), { scriptSources: { ...SCRIPT_SOURCES, [SEED_EDITOR_FILE]: '() => null\n' } })).result;
  assert.equal(after.manifestHash, before.manifestHash);
});

// The unsafe project with countOrders' argument vector, or another command's, replaced.
const withArguments = (name: string, argv: readonly JsonRecord[]): JsonRecord => unsafeProjectFile(FEATURES, {
  unsafeFeatures: {
    ...unsafeSection(FEATURES),
    databaseCommands: { commands: { ...DATABASE_COMMANDS, [name]: { ...(DATABASE_COMMANDS[name] as JsonRecord), argv } } },
  },
});
const COMMAND_PLAN = (): JsonRecord => unsafePlan([OPEN_CART, ORDER_COUNT_CHECK]);

test('the manifest records one sha256 for the database command the plan uses, by its declared name', { criterion: 'AC-SPEC-36-17' }, async () => {
  const { result } = await runUnsafePlan(COMMAND_PLAN());
  const records = manifestOf(result).unsafeDeclarations ?? [];
  assert.deepEqual(records.map((record) => [record.kind, record.name]), [['command', 'countOrders']]);
  assert.match(records[0]?.sha256 ?? '', /^[0-9a-f]{64}$/);
});

test('a change to the command\'s argument vector changes the manifest hash, though the plan is the same', { criterion: 'AC-SPEC-36-17' }, async () => {
  const before = (await runUnsafePlan(COMMAND_PLAN())).result;
  const changed = [{ literal: 'node' }, { literal: 'scripts/count-orders.js' }, { literal: '--verbose' }, { literal: '--' }, { $parameter: 'email' }];
  const after = (await runUnsafePlan(COMMAND_PLAN(), { projectFile: withArguments('countOrders', changed) })).result;
  assert.equal(manifestOf(after).planHash, manifestOf(before).planHash);
  assert.notEqual(manifestOf(after).unsafeDeclarations?.[0]?.sha256, manifestOf(before).unsafeDeclarations?.[0]?.sha256);
  assert.notEqual(after.manifestHash, before.manifestHash);
});

test('a change to a command the plan does not use leaves the manifest hash as it was', { criterion: 'AC-SPEC-36-17' }, async () => {
  const before = (await runUnsafePlan(COMMAND_PLAN())).result;
  const after = (await runUnsafePlan(COMMAND_PLAN(), { projectFile: withArguments('wipeOrders', [{ literal: 'node' }, { literal: 'scripts/wipe-all.js' }]) })).result;
  assert.equal(after.manifestHash, before.manifestHash);
});
