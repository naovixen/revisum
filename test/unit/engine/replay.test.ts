// Replay from a manifest, on a driver that needs no browser: the verdicts a replay gives, the
// inputs it refuses before any driver call, and the runs it never claims.
//   - verdicts (AC-06): identical only when the result hashes match; a replay on another host,
//     browser or build is a per-environment baseline, any other differing input a mismatch, and
//     neither is a pass;
//   - fixtures (AC-07): a fixture that is missing or whose hash differs ends replay-mismatch naming
//     it, before any driver call;
//   - manifests (AC-08): a newer or unknown schema, or an unknown key, is refused version-unsupported
//     by decodeManifest and by replay; a known field of the wrong shape is a mismatch at its path;
//   - unpinnable inputs (AC-03): an adapter that cannot pin the clock, the time zone or randomness
//     lists them in nonHermeticInputs, loses replay-identical to determinism-unpinned, and its runs
//     are refused replay-not-claimed.
// See docs/specs/SPEC-08-manifest-and-replay.md.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { canonicalJson, replayManifest } from '@revisum/engine';
import {
  PER_ENVIRONMENT_FIELDS, closedScenario, decodeManifest, refused, removeFakeExecutables, replayRun, replayed, runScenario,
  type Replay, type Scenario, type ScenarioRun,
} from './replay-examples.ts';
import { OPEN_ORDERS, navigate, planOf, projectFileWith } from './run-value-examples.ts';

after(removeFakeExecutables);

const CLOSED: Scenario = closedScenario(projectFileWith(), planOf([OPEN_ORDERS]));

// The run's manifest as JSON, with `change` applied to a copy.
const manifestJson = (ran: ScenarioRun, change: (manifest: Record<string, unknown>) => void = () => undefined): unknown => {
  const copy: Record<string, unknown> = JSON.parse(JSON.stringify(ran.manifest));
  change(copy);
  return copy;
};

const assertNoDriverCall = (replay: Replay): void => {
  assert.deepEqual(replay.driverCalls.order, [], 'the replay called the driver');
};

// ---- Verdicts ---------------------------------------------------------------------------------

test('a replay of the same manifest on the same host is identical, with no differing input', { criterion: 'AC-SPEC-08-06' }, async () => {
  const ran = await runScenario(CLOSED);
  const outcome = replayed((await replayRun(ran)).answer);
  assert.deepEqual(outcome, {
    identical: true, resultHash: ran.result.resultHash, manifestHash: ran.result.manifestHash, differingInputs: [], verdict: 'identical',
  });
});

test('a replay on another host says the hashes differ and reports a per-environment baseline, not a pass', { criterion: 'AC-SPEC-08-06' }, async () => {
  const ran = await runScenario(CLOSED);
  const outcome = replayed((await replayRun(ran, { host: { platform: 'linux', arch: 'x64' } })).answer);
  assert.equal(outcome.identical, false);
  assert.notEqual(outcome.resultHash, ran.result.resultHash);
  assert.deepEqual(outcome.differingInputs, ['host']);
  assert.equal(outcome.verdict, 'per-environment-baseline');
});

test('a replay on another host and browser build is still a per-environment baseline', { criterion: 'AC-SPEC-08-06' }, async () => {
  const built: Scenario = { ...CLOSED, executable: 'browser build one', browserVersion: '156.0.1' };
  const ran = await runScenario(built);
  const elsewhere: Scenario = { ...built, executable: 'browser build two', browserVersion: '156.0.2', host: { platform: 'linux', arch: 'x64' } };
  const outcome = replayed((await replayRun(ran, { scenario: elsewhere })).answer);
  assert.equal(outcome.identical, false);
  assert.deepEqual([...outcome.differingInputs].sort(), ['browser', 'executableSha256', 'host']);
  assert.ok(outcome.differingInputs.every((field) => PER_ENVIRONMENT_FIELDS.some((allowed) => allowed === field)));
  assert.equal(outcome.verdict, 'per-environment-baseline');
});

test('counter-example: a manifest from another engine version is a mismatch, not a per-environment baseline', { criterion: 'AC-SPEC-08-06' }, async () => {
  const ran = await runScenario(CLOSED);
  const outcome = replayed((await replayRun(ran, { manifest: manifestJson(ran, (manifest) => { manifest['engineVersion'] = '0.0.9'; }) })).answer);
  assert.equal(outcome.identical, false);
  assert.ok(outcome.differingInputs.includes('engineVersion'), JSON.stringify(outcome.differingInputs));
  assert.equal(outcome.verdict, 'mismatch');
});

test('a replay whose inputs all match but whose result hash differs from the recorded one is a mismatch', { criterion: 'AC-SPEC-08-06' }, async () => {
  const ran = await runScenario(CLOSED);
  const recordedResultHash = ran.result.resultHash.replace(/^./, (first) => (first === '0' ? '1' : '0'));
  const outcome = replayed((await replayRun(ran, { recordedResultHash })).answer);
  assert.equal(outcome.identical, false);
  assert.deepEqual(outcome.differingInputs, []);
  assert.equal(outcome.verdict, 'mismatch');
});

test('identical is true exactly when the replay\'s result hash equals the recorded one', { criterion: 'AC-SPEC-08-06' }, async () => {
  const ran = await runScenario(CLOSED);
  const replays = [
    await replayRun(ran),
    await replayRun(ran, { host: { platform: 'linux', arch: 'arm64' } }),
    await replayRun(ran, { recordedResultHash: '0'.repeat(64) }),
  ];
  for (const replay of replays) {
    const outcome = replayed(replay.answer);
    const recorded = replay === replays[2] ? '0'.repeat(64) : ran.result.resultHash;
    assert.equal(outcome.identical, outcome.resultHash === recorded, JSON.stringify(outcome));
    assert.equal(outcome.identical, outcome.verdict === 'identical', JSON.stringify(outcome));
  }
});

// ---- Inputs a replay checks first ---------------------------------------------------------------

test('a replay whose manifest names a fixture that is missing ends replay-mismatch naming it, before any driver call', { criterion: 'AC-SPEC-08-07' }, async () => {
  const ran = await runScenario(CLOSED);
  const replay = await replayRun(ran, { readFixture: (path) => (path === '/app.js' ? null : new TextEncoder().encode(CLOSED.fixtures.find((file) => file.path === path)?.text ?? '')) });
  assert.deepEqual(refused(replay.answer), { code: 'replay-mismatch', fixture: '/app.js' });
  assertNoDriverCall(replay);
});

test('a replay whose fixture differs by one byte ends replay-mismatch naming it, before any driver call', { criterion: 'AC-SPEC-08-07' }, async () => {
  const ran = await runScenario(CLOSED);
  const replay = await replayRun(ran, {
    readFixture: (path) => {
      const text = CLOSED.fixtures.find((file) => file.path === path)?.text ?? '';
      return new TextEncoder().encode(path === '/index.html' ? `${text} ` : text);
    },
  });
  assert.deepEqual(refused(replay.answer), { code: 'replay-mismatch', fixture: '/index.html' });
  assertNoDriverCall(replay);
});

test('counter-example: the same fixtures, read back unchanged, replay identically', { criterion: 'AC-SPEC-08-07' }, async () => {
  const ran = await runScenario(CLOSED);
  const replay = await replayRun(ran, { readFixture: (path) => new TextEncoder().encode(CLOSED.fixtures.find((file) => file.path === path)?.text ?? '') });
  assert.equal(replayed(replay.answer).identical, true);
});

test('a replay given another plan than the manifest\'s ends replay-mismatch, before any driver call', { criterion: 'AC-SPEC-08-07' }, async () => {
  const ran = await runScenario(CLOSED);
  const replay = await replayRun(ran, { scenario: { ...CLOSED, plan: planOf([navigate('/orders/archive')]) } });
  assert.equal(refused(replay.answer).code, 'replay-mismatch');
  assertNoDriverCall(replay);
});

test('a replay whose manifest names another target ends replay-mismatch, before any driver call', { criterion: 'AC-SPEC-08-07' }, async () => {
  const ran = await runScenario(CLOSED);
  const manifest = manifestJson(ran, (copy) => { copy['target'] = { ...Object(copy['target']), id: 'playwright-firefox' }; });
  const replay = await replayRun(ran, { manifest });
  assert.equal(refused(replay.answer).code, 'replay-mismatch');
  assertNoDriverCall(replay);
});

// ---- Manifests from other versions ------------------------------------------------------------

test('decodeManifest reads back a run\'s manifest from its JSON unchanged', { criterion: 'AC-SPEC-08-08' }, async () => {
  const ran = await runScenario(CLOSED);
  const decoded = await decodeManifest(manifestJson(ran));
  assert.ok(decoded.ok, JSON.stringify(decoded));
  assert.equal(canonicalJson(decoded.value), canonicalJson(ran.manifest));
});

const REFUSED_SCHEMAS = [
  { name: 'a newer version', schema: 'revisum.run-manifest/v2' },
  { name: 'another kind of file', schema: 'revisum.run-recording/v1' },
  { name: 'another product\'s namespace', schema: 'acme.run-manifest/v1' },
] as const;

for (const refusedSchema of REFUSED_SCHEMAS) {
  test(`a manifest whose schema is ${refusedSchema.name} is refused version-unsupported`, { criterion: 'AC-SPEC-08-08' }, async () => {
    const ran = await runScenario(CLOSED);
    const manifest = manifestJson(ran, (copy) => { copy['schema'] = refusedSchema.schema; });
    const decoded = await decodeManifest(manifest);
    assert.equal(decoded.ok ? 'decoded' : decoded.error.code, 'version-unsupported');
    const replay = await replayRun(ran, { manifest });
    assert.equal(refused(replay.answer).code, 'version-unsupported');
    assertNoDriverCall(replay);
  });
}

test('a manifest with a key this version does not know is refused version-unsupported', { criterion: 'AC-SPEC-08-08' }, async () => {
  const ran = await runScenario(CLOSED);
  const manifest = manifestJson(ran, (copy) => { copy['deviceMemory'] = 8; });
  const decoded = await decodeManifest(manifest);
  assert.equal(decoded.ok ? 'decoded' : decoded.error.code, 'version-unsupported');
  const replay = await replayRun(ran, { manifest });
  assert.equal(refused(replay.answer).code, 'version-unsupported');
  assertNoDriverCall(replay);
});

test('a manifest with a known field of the wrong shape ends replay-mismatch at that field\'s JSON path', { criterion: 'AC-SPEC-08-08' }, async () => {
  const ran = await runScenario(CLOSED);
  const manifest = manifestJson(ran, (copy) => { copy['seeds'] = { random: 'seven' }; });
  const decoded = await decodeManifest(manifest);
  assert.deepEqual(decoded.ok ? 'decoded' : decoded.error, { code: 'replay-mismatch', path: '$.seeds.random' });
  const replay = await replayRun(ran, { manifest });
  assert.deepEqual(refused(replay.answer), { code: 'replay-mismatch', path: '$.seeds.random' });
  assertNoDriverCall(replay);
});

test('something that is not a manifest at all is refused before any driver call', { criterion: 'AC-SPEC-08-08' }, async () => {
  const ran = await runScenario(CLOSED);
  for (const manifest of [null, 'revisum.run-manifest/v1', [], {}]) {
    const replay = await replayRun(ran, { manifest });
    assert.ok(['version-unsupported', 'replay-mismatch'].includes(refused(replay.answer).code), JSON.stringify(replay.answer));
    assertNoDriverCall(replay);
  }
});

// ---- Inputs an adapter cannot pin ---------------------------------------------------------------

for (const input of ['clock', 'time-zone', 'randomness']) {
  test(`an adapter that cannot pin ${input} puts it in nonHermeticInputs, and the run is not replay-claimed`, { criterion: 'AC-SPEC-08-03' }, async () => {
    const ran = await runScenario({ ...CLOSED, cannotPin: [input] });
    assert.ok(ran.manifest.nonHermeticInputs.includes(input), JSON.stringify(ran.manifest.nonHermeticInputs));
    const lost = ran.result.guarantees.lost.map((loss) => `${loss.guarantee} ${String(loss.because)}`);
    assert.ok(lost.includes('replay-identical determinism-unpinned'), JSON.stringify(lost));
    const claimed = replayManifest(ran.manifest);
    assert.equal(claimed.ok ? 'claimed' : claimed.error.code, 'replay-not-claimed');
    const replay = await replayRun(ran);
    assert.equal(refused(replay.answer).code, 'replay-not-claimed');
    assertNoDriverCall(replay);
  });
}

test('counter-example: an adapter that pins the clock, time zone and randomness keeps its runs replay-claimed', { criterion: 'AC-SPEC-08-03' }, async () => {
  const ran = await runScenario(CLOSED);
  assert.deepEqual(ran.manifest.nonHermeticInputs, []);
  assert.equal(ran.result.guarantees.lost.some((loss) => String(loss.because) === 'determinism-unpinned'), false);
  assert.equal(replayManifest(ran.manifest).ok, true);
  assert.equal(replayed((await replayRun(ran)).answer).identical, true);
});
