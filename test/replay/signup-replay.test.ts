// Replay in a real browser, on the sign-up fixture app.
//   - AC-01: one run of the sign-up plan on the CDP driver's headless shell, then 20 replays of its
//     manifest, each identical to the run. CI and `npm run check:linux` run this in the pinned Linux
//     image, which is what the criterion claims.
//   - AC-04: that run's manifest holds the sha256 of the headless-shell executable on disk.
//   - AC-06: golden/replay/windows-signup/ holds a manifest and result hash made on Windows (its
//     README says how). Replayed on a machine with the golden's platform and architecture it is
//     identical; anywhere else, such as the Linux image, the hashes differ, `host` is among the
//     differing inputs, and the verdict is a per-environment baseline: never a pass.
// The browser never runs headed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { arch, platform } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  defaultRedactor, hashExecutable, type RunResult, type TargetId,
} from '@revisum/engine';
import { BROWSERS } from '../support/browsers.ts';
import { memoryArtifactStore, memoryEventSink, memoryRunEventSink, systemClock } from '../support/memory-ports.ts';
import { authorise, trustedProjectFrom } from '../support/policy-clearance.ts';
import { FIXTURES, GOLDEN } from '../support/repository.ts';
import { harness, makeDrivers, makeProjectFile, signupPlan, type Harness } from '../support/signup-harness.ts';
import { PER_ENVIRONMENT_FIELDS, engineFunction, replayAnswerOf, replayed, type ReplayAnswer } from '../unit/engine/replay-examples.ts';

const REPLAYS = 20;
const HEADLESS_SHELL = 'cdp-chromium-headless-shell';
const GOLDEN_RUN = join(GOLDEN, 'replay', 'windows-signup');
const SIGNUP_APP = join(FIXTURES, 'signup-app');

let testHarness: Harness;
before(async () => { testHarness = await harness(); });
after(async () => { await testHarness.close(); });

// The fixture app's files, read by the paths the manifest names them by ("/app.js").
const fixtureReader = {
  read: async (path: string): Promise<Uint8Array | null> => {
    try {
      return new Uint8Array(readFileSync(join(SIGNUP_APP, path.replace(/^\//, ''))));
    } catch {
      return null;
    }
  },
};

// The target's id as the trusted test project's matrix holds it.
const targetOf = (id: string): TargetId => testHarness.project.matrix.find((target) => target.id === id)?.id ?? assert.fail(`no target ${id}`);

// Replays `manifest` with the harness's project and fresh ports, on this machine.
async function replaySignup(rawPlan: unknown, targetId: string, manifest: unknown, recordedResultHash: string): Promise<ReplayAnswer> {
  const trusted = await trustedProjectFrom(makeProjectFile(testHarness.server.origin));
  const { seed: _seed, fixedTimeMilliseconds: _clock, fixtures: _fixtures, ...inputs } = testHarness.base();
  const request = {
    manifest, recording: null, recordedResultHash,
    inputs: { ...inputs, plan: authorise(testHarness.plan(rawPlan), trusted), targetId: targetOf(targetId) },
  };
  const ports = {
    drivers: makeDrivers(), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), audit: memoryEventSink(),
    events: memoryRunEventSink(), fixtures: fixtureReader,
  };
  const replay = await engineFunction('replay');
  return replayAnswerOf(await replay(request, ports));
}

let headlessRun: { readonly plan: unknown; readonly result: RunResult } | undefined;
async function signupRunOnHeadlessShell(): Promise<{ readonly plan: unknown; readonly result: RunResult }> {
  if (headlessRun === undefined) {
    const plan = signupPlan([HEADLESS_SHELL]);
    const { result } = await testHarness.run(testHarness.plan(plan), HEADLESS_SHELL);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    headlessRun = { plan, result };
  }
  return headlessRun;
}

test('the sign-up run\'s manifest, replayed 20 times on the headless shell, gives an identical result hash every time', { timeout: 600_000 }, async () => {
  const { plan, result } = await signupRunOnHeadlessShell();
  const manifest: unknown = JSON.parse(JSON.stringify(result.manifest));
  for (let index = 0; index < REPLAYS; index++) {
    const outcome = replayed(await replaySignup(plan, HEADLESS_SHELL, manifest, result.resultHash));
    assert.equal(outcome.resultHash, result.resultHash, `replay ${index + 1} gave another result hash`);
    assert.equal(outcome.manifestHash, result.manifestHash, `replay ${index + 1} made another manifest`);
    assert.deepEqual(outcome.differingInputs, [], `replay ${index + 1}`);
    assert.equal(outcome.identical, true, `replay ${index + 1}`);
    assert.equal(outcome.verdict, 'identical', `replay ${index + 1}`);
  }
});

test('the headless-shell run records the sha256 of the executable it launched', { timeout: 120_000 }, async () => {
  const { result } = await signupRunOnHeadlessShell();
  const hashed = await hashExecutable(BROWSERS.chromeHeadlessShell);
  assert.ok(hashed.ok, hashed.ok ? '' : hashed.error);
  const manifest: Readonly<Record<string, unknown>> = result.manifest ?? assert.fail('the run made no manifest');
  assert.equal(manifest['executableSha256'], hashed.value);
});

// ---- The Windows-made golden ------------------------------------------------------------------------

const readJson = (name: string): unknown => JSON.parse(readFileSync(join(GOLDEN_RUN, name), 'utf8'));

function goldenRecord(): { readonly plan: unknown; readonly manifest: Readonly<Record<string, unknown>>; readonly resultHash: string; readonly manifestHash: string } {
  const manifest = readJson('manifest.json');
  const hashes = readJson('result-hash.json');
  assert.ok(typeof manifest === 'object' && manifest !== null && !Array.isArray(manifest), 'the golden manifest is not an object');
  assert.ok(typeof hashes === 'object' && hashes !== null, 'the golden hashes are not an object');
  const resultHash = Reflect.get(hashes, 'resultHash');
  const manifestHash = Reflect.get(hashes, 'manifestHash');
  assert.ok(typeof resultHash === 'string' && typeof manifestHash === 'string', 'the golden has no result or manifest hash');
  return { plan: readJson('plan.json'), manifest: Object.fromEntries(Object.entries(manifest)), resultHash, manifestHash };
}

test('the Windows-made golden was made on Windows, on the target and fixtures this repository holds', () => {
  const golden = goldenRecord();
  assert.deepEqual(golden.manifest['host'], { platform: 'win32', arch: 'x64' });
  const target = golden.manifest['target'];
  assert.ok(typeof target === 'object' && target !== null && Reflect.get(target, 'id') === 'cdp-chromium', JSON.stringify(target));
  assert.deepEqual(golden.manifest['fixtures'], testHarness.server.fixtures.map((fixture) => ({ path: fixture.path, sha256: fixture.sha256 }))
    .sort((left, right) => (left.path < right.path ? -1 : 1)));
});

test('the Windows-made manifest, replayed here, states whether the hashes match and never passes a mismatch', { timeout: 120_000 }, async () => {
  const golden = goldenRecord();
  const outcome = replayed(await replaySignup(golden.plan, 'cdp-chromium', golden.manifest, golden.resultHash));
  assert.equal(outcome.identical, outcome.resultHash === golden.resultHash, 'identical must say whether the hashes match');
  const sameHost = platform() === 'win32' && arch() === 'x64';
  if (sameHost) {
    // Made on this kind of machine: the replay must match the golden exactly.
    assert.equal(outcome.identical, true, JSON.stringify(outcome));
    assert.equal(outcome.verdict, 'identical');
    assert.deepEqual(outcome.differingInputs, []);
  } else {
    assert.equal(outcome.identical, false, JSON.stringify(outcome));
    assert.ok(outcome.differingInputs.includes('host'), JSON.stringify(outcome.differingInputs));
    assert.deepEqual(outcome.differingInputs.filter((field) => !PER_ENVIRONMENT_FIELDS.some((allowed) => allowed === field)), []);
    assert.equal(outcome.verdict, 'per-environment-baseline');
  }
});

describe('Using a replay of the Windows-made golden', () => {
  describe('given a manifest from another host and browser build', () => {
    describe('when it is replayed here', () => {
      test('then it should report a per-environment baseline and never a pass', { timeout: 120_000 }, async () => {
        const golden = goldenRecord();
        const elsewhere = { ...golden.manifest, host: { platform: 'other-platform', arch: 'other-arch' }, executableSha256: '0'.repeat(64) };
        const outcome = replayed(await replaySignup(golden.plan, 'cdp-chromium', elsewhere, golden.resultHash));
        assert.equal(outcome.identical, false, JSON.stringify(outcome));
        assert.ok(outcome.differingInputs.includes('host'), JSON.stringify(outcome.differingInputs));
        assert.ok(outcome.differingInputs.includes('executableSha256'), JSON.stringify(outcome.differingInputs));
        assert.deepEqual(outcome.differingInputs.filter((field) => !PER_ENVIRONMENT_FIELDS.some((allowed) => allowed === field)), []);
        assert.equal(outcome.verdict, 'per-environment-baseline');
      });
    });
  });
});

test('counter-example: the Windows-made manifest from another engine version is a mismatch on any machine', { timeout: 120_000 }, async () => {
  const golden = goldenRecord();
  const changed = { ...golden.manifest, engineVersion: '0.0.9' };
  const outcome = replayed(await replaySignup(golden.plan, 'cdp-chromium', changed, golden.resultHash));
  assert.equal(outcome.identical, false);
  assert.ok(outcome.differingInputs.includes('engineVersion'), JSON.stringify(outcome.differingInputs));
  assert.equal(outcome.verdict, 'mismatch');
});
