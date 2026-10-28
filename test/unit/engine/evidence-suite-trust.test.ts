// Evidence mode and its suites are trusted the way project.json is: by where they come from. A
// change that turns evidence mode on, or edits a suite declaration, in its own project.json runs
// against the protected-branch version and raises changed-with-code, so it cannot run its own
// suite before it is approved. The declared suite paths join the trusted files: a change that
// edits a test or a helper inside them raises changed-with-code for each file, the gating pass runs
// the protected branch's suite files, and the change's own version runs only as a proposal pass,
// labelled proposal, which never opens the merge gate. So an agent cannot make a run pass by
// editing the tests in the same change.
// See docs/specs/SPEC-35-evidence-mode.md and docs/specs/SPEC-02-project-trust-and-approval.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson } from '@revisum/engine';
import { FIXTURES } from '../../support/repository.ts';
import {
  PROJECT_PATH, eventsOfKind, loadForChange, memoryEventSink, withRepository, type FixtureRepository,
} from './approval-repositories.ts';
import {
  SUITE_FOLDER, SUITE_NAME, chooseSuite, declaredCheckoutSuite, evidenceRun, opensMergeGate, passesFor, recordedReport, testsOf,
  withoutSpec, type JsonRecord,
} from './evidence-examples.ts';

type HostileChange = { readonly description: string; readonly changedFiles: readonly string[]; readonly workingCopy: Record<string, unknown> };

const hostileChange = (): HostileChange =>
  JSON.parse(readFileSync(join(FIXTURES, 'evidence-mode', 'hostile-change.json'), 'utf8'));

// The project.json the hostile change writes: the solo project with evidence mode turned on.
const projectWithEvidence = (): JsonRecord => structuredClone(hostileChange().workingCopy[PROJECT_PATH]) as JsonRecord;

const applyHostileChange = (fixture: FixtureRepository): void => { Object.assign(fixture.workingCopy, hostileChange().workingCopy); };

// The protected branch already holds the evidence-mode project.json.
const protectEvidenceMode = (fixture: FixtureRepository): void => { fixture.protectedFiles[PROJECT_PATH] = projectWithEvidence(); };

// ---- A change that turns evidence mode on or edits it -------------------------------------------

test('a change that turns evidence mode on in its own project.json runs on the protected version, without evidence mode', { criterion: 'AC-SPEC-35-03' }, async () => {
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), hostileChange().changedFiles, memoryEventSink());
    assert.ok(loaded.ok, JSON.stringify(loaded));
    assert.equal(loaded.value.project.evidenceMode, undefined, 'the change\'s evidenceMode section was trusted');
    assert.equal(loaded.value.project.provenance.kind, 'protected-branch');
  }, applyHostileChange);
});

test('so the change\'s own suite cannot be run: run --suite is refused with evidence-mode-disabled', { criterion: 'AC-SPEC-35-03' }, async () => {
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), hostileChange().changedFiles, memoryEventSink());
    assert.ok(loaded.ok, JSON.stringify(loaded));
    const chosen = chooseSuite(loaded.value.project, SUITE_NAME);
    assert.equal(chosen.ok, false, 'the change\'s own suite was chosen to run');
    if (!chosen.ok) assert.equal(chosen.error.code, 'evidence-mode-disabled');
  }, applyHostileChange);
});

test('the change\'s edit of project.json raises one changed-with-code item and event naming it', { criterion: 'AC-SPEC-35-03' }, async () => {
  await withRepository('solo', async (repository) => {
    const events = memoryEventSink();
    const loaded = await loadForChange(repository.versionControl(), hostileChange().changedFiles, events);
    assert.ok(loaded.ok, JSON.stringify(loaded));
    // The suite file is not trusted here: the protected project declares no suite.
    assert.deepEqual(loaded.value.reviewItems, [{ code: 'changed-with-code', path: PROJECT_PATH }]);
    assert.equal(eventsOfKind(events, 'trusted.changed-with-code').length, 1, JSON.stringify(events.recorded));
  }, applyHostileChange);
});

test('the same evidenceMode section, once on the protected branch, lets run --suite choose the suite', { criterion: 'AC-SPEC-35-03' }, async () => {
  // The counter-example: the section itself is valid, so the refusal above comes from where it was read.
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), [], memoryEventSink());
    assert.ok(loaded.ok, JSON.stringify(loaded));
    const chosen = chooseSuite(loaded.value.project, SUITE_NAME);
    assert.ok(chosen.ok, JSON.stringify(chosen));
    assert.deepEqual(chosen.value.paths, ['e2e/**']);
  }, protectEvidenceMode);
});

test('a change that edits a declared suite runs the protected declaration, unchanged', { criterion: 'AC-SPEC-35-03' }, async () => {
  // Metamorphic: the change's edit to the declaration must not change what core trusts.
  const widenSuite = (fixture: FixtureRepository): void => {
    protectEvidenceMode(fixture);
    const edited = projectWithEvidence();
    const suite = ((edited['evidenceMode'] as JsonRecord)['suites'] as JsonRecord[])[0];
    assert.ok(suite !== undefined);
    suite['paths'] = ['e2e/smoke/**'];
    suite['projects'] = ['chromium', 'firefox'];
    suite['image'] = `sha256:${'fedcba9876543210'.repeat(4)}`;
    fixture.workingCopy[PROJECT_PATH] = edited;
  };
  await withRepository('solo', async (repository) => {
    const untouched = await loadForChange(repository.versionControl(), [], memoryEventSink());
    const edited = await loadForChange(repository.versionControl(), [PROJECT_PATH, 'src/checkout.ts'], memoryEventSink());
    assert.ok(untouched.ok && edited.ok, JSON.stringify({ untouched, edited }));
    assert.equal(canonicalJson(edited.value.project.evidenceMode), canonicalJson(untouched.value.project.evidenceMode));
    assert.deepEqual(edited.value.reviewItems, [{ code: 'changed-with-code', path: PROJECT_PATH }]);
  }, widenSuite);
});

// ---- A change that edits the suite's own files ---------------------------------------------------

const SUITE_EDITS = ['e2e/checkout.spec.ts', 'e2e/helpers/sign-in.ts'];
const APPLICATION_CODE = 'src/checkout.ts';

test('each suite file the change edits, a helper included, raises its own changed-with-code item and event', { criterion: 'AC-SPEC-35-04' }, async () => {
  await withRepository('solo', async (repository) => {
    const events = memoryEventSink();
    const loaded = await loadForChange(repository.versionControl(), [...SUITE_EDITS, APPLICATION_CODE], events);
    assert.ok(loaded.ok, JSON.stringify(loaded));
    assert.deepEqual(
      [...loaded.value.reviewItems].sort((left, right) => (left.path < right.path ? -1 : 1)),
      SUITE_EDITS.map((path) => ({ code: 'changed-with-code', path })),
    );
    const named = eventsOfKind(events, 'trusted.changed-with-code').map(({ event }) => JSON.stringify(event));
    assert.equal(named.length, 2, JSON.stringify(events.recorded));
    for (const path of SUITE_EDITS) assert.ok(named.some((event) => event.includes(path)), `no event names ${path}`);
  }, protectEvidenceMode);
});

test('the same edits raise nothing when the protected project declares no suite', { criterion: 'AC-SPEC-35-04' }, async () => {
  // The counter-example: the files are trusted because the protected declaration names them.
  await withRepository('solo', async (repository) => {
    const loaded = await loadForChange(repository.versionControl(), [...SUITE_EDITS, APPLICATION_CODE], memoryEventSink());
    assert.ok(loaded.ok, JSON.stringify(loaded));
    assert.deepEqual(loaded.value.reviewItems, []);
  });
});

test('a change that edits only application code raises no item, even with a suite declared', { criterion: 'AC-SPEC-35-04' }, async () => {
  await withRepository('solo', async (repository) => {
    const events = memoryEventSink();
    const loaded = await loadForChange(repository.versionControl(), [APPLICATION_CODE, 'e2e-notes.md'], events);
    assert.ok(loaded.ok, JSON.stringify(loaded));
    assert.deepEqual(loaded.value.reviewItems, []);
    assert.deepEqual(events.recorded, []);
  }, protectEvidenceMode);
});

const CHANGED_TEST = `${SUITE_FOLDER}/e2e/checkout.spec.ts`;
const passesOf = (passes: ReturnType<typeof passesFor>) => passes.map((entry) => ({ pass: entry.pass, suiteFiles: entry.suiteFiles }));

test('a change that edits a suite file gets a gating pass on the protected suite files and a proposal pass on its own', { criterion: 'AC-SPEC-35-04' }, () => {
  assert.deepEqual(passesOf(passesFor(declaredCheckoutSuite(), [CHANGED_TEST, `${SUITE_FOLDER}/src/cart.ts`])), [
    { pass: 'gating', suiteFiles: 'protected-branch' },
    { pass: 'proposal', suiteFiles: 'change' },
  ]);
});

test('with runChangedTestsAsProposal off, the change gets only the gating pass on the protected suite files', { criterion: 'AC-SPEC-35-04' }, () => {
  assert.deepEqual(passesOf(passesFor(declaredCheckoutSuite({ runChangedTestsAsProposal: false }), [CHANGED_TEST])), [
    { pass: 'gating', suiteFiles: 'protected-branch' },
  ]);
});

test('a change that edits no suite file gets only the gating pass, still on the protected suite files', { criterion: 'AC-SPEC-35-04' }, () => {
  assert.deepEqual(passesOf(passesFor(declaredCheckoutSuite(), [`${SUITE_FOLDER}/src/cart.ts`])), [
    { pass: 'gating', suiteFiles: 'protected-branch' },
  ]);
});

test('every test of a proposal pass is labelled proposal, and of a gating pass gating', { criterion: 'AC-SPEC-35-04' }, () => {
  const report = recordedReport('passing-with-criteria');
  const proposal = testsOf(evidenceRun(report, { pass: 'proposal' }));
  const gating = testsOf(evidenceRun(report, { pass: 'gating' }));
  assert.ok(proposal.length > 0);
  assert.deepEqual(proposal.map((entry) => entry.pass), proposal.map(() => 'proposal'));
  assert.deepEqual(gating.map((entry) => entry.pass), gating.map(() => 'gating'));
});

// The passing report without its spec whose invalid criterion ids raise a review item, so nothing
// but the pass can keep the gate shut.
const cleanPassingReport = (): JsonRecord => withoutSpec(recordedReport('passing-with-criteria'), 1);

test('a proposal pass never opens the merge gate, even when every test passed', { criterion: 'AC-SPEC-35-04' }, () => {
  const report = cleanPassingReport();
  const proposal = evidenceRun(report, { pass: 'proposal' });
  assert.equal(proposal.state, 'Passed', 'the counter-example below needs a passing run');
  assert.equal(opensMergeGate(proposal), false);
});

test('the gating pass of the same passing report does open the merge gate', { criterion: 'AC-SPEC-35-04' }, () => {
  // The counter-example: only the pass differs from the case above.
  assert.equal(opensMergeGate(evidenceRun(cleanPassingReport(), { pass: 'gating' })), true);
});
