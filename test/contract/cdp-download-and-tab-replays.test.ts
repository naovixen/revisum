// Replays of one plan with two downloads and a newTab on the own CDP driver give one result hash.
// The plan downloads a CSV and checks it, opens /account in a second tab and checks it there,
// then downloads and checks a second CSV in the first tab. 20 replays share one browser, so the
// file stays quick: every replay still asks the driver for its session, and the test shows each
// asked with the same environment. The pinned Linux image runs it with npm run check:linux.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  CDP_TARGET, CLOCK_START_MILLISECONDS, download, expectDownload, navigate, newTab, pagePlan, pageStatesHarness, reusedSessionDriver, role,
  testId, textEquals, type PageStatesHarness,
} from './page-states-support.ts';

let harness: PageStatesHarness;
before(async () => { harness = await pageStatesHarness(); });
after(async () => { await harness.close(); });

const REPLAYS = 20;

const replayedSteps = () => [
  navigate('/downloads.html'),
  download('project-list', role('link', 'Export CSV')),
  expectDownload('project-list', { kind: 'fileNameEquals', value: 'projects.csv' }, 'replays.project-file-name'),
  expectDownload('project-list', { kind: 'sizeAtLeast', value: harness.files.projects.bytes.length }, 'replays.project-size'),
  expectDownload('project-list', { kind: 'contentContains', value: 'Website relaunch' }, 'replays.project-content'),
  newTab('/account', [
    textEquals(testId('session-cookie'), 'Signed out', 'replays.tab-signed-out'),
    textEquals(testId('page-now'), String(CLOCK_START_MILLISECONDS), 'replays.tab-clock'),
  ]),
  download('invoice-list', role('link', 'Export invoices')),
  expectDownload('invoice-list', { kind: 'contentContains', value: 'INV-1' }, 'replays.invoice-content'),
  textEquals(testId('download-status'), 'Ready', 'replays.page-ready'),
];

test('20 replays of a plan with downloads and a newTab give one result hash, each from the same session environment', { criterion: 'AC-SPEC-31-14', timeout: 300_000 }, async () => {
  const plan = harness.plan(pagePlan(CDP_TARGET, replayedSteps()));
  const adapter = harness.target(CDP_TARGET).adapter;
  const inner = harness.drivers.get(adapter);
  assert.ok(inner !== undefined, `a driver for ${adapter}`);
  const reused = reusedSessionDriver(inner);
  const drivers = new Map([...harness.drivers, [adapter, reused.driver]]);
  const hashes = new Set<string>();
  try {
    for (let replay = 0; replay < REPLAYS; replay++) {
      const { result } = await harness.run(plan, CDP_TARGET, { drivers });
      assert.equal(result.state, 'Passed', `replay ${replay}: ${JSON.stringify(result.steps)}`);
      hashes.add(result.resultHash);
    }
  } finally {
    await reused.closeAll();
  }
  assert.equal(hashes.size, 1, 'every replay gives the same result hash');
  assert.equal(reused.environments.length, REPLAYS, 'every replay asked for its session');
  for (const environment of reused.environments) assert.deepEqual(environment, reused.environments[0]);
});

// Counter-example: a plan that differs in one check gives another hash, so one hash across the
// replays is not a hash that ignores the steps.
test('counter-example: the same plan with one check changed gives a different result hash', { criterion: 'AC-SPEC-31-14', timeout: 120_000 }, async () => {
  const steps = replayedSteps();
  const changed = [...steps.slice(0, -1), textEquals(testId('download-status'), 'Ready', 'replays.page-ready-again')];
  const first = await harness.run(harness.plan(pagePlan(CDP_TARGET, steps)), CDP_TARGET);
  const second = await harness.run(harness.plan(pagePlan(CDP_TARGET, changed)), CDP_TARGET);
  assert.equal(first.result.state, 'Passed', JSON.stringify(first.result.steps));
  assert.equal(second.result.state, 'Passed', JSON.stringify(second.result.steps));
  assert.notEqual(first.result.resultHash, second.result.resultHash);
});
