// Target resolution at run time: core runs exactly the declared target or ends the run
// TargetUnavailable with the reason, and never tries another adapter, device or build instead.
// See docs/specs/SPEC-05-target-matrix-and-lock.md.
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { adapterRegistry, planParser, type Target } from '@revisum/engine';
import { signupPlan, withValue } from './plan-examples.ts';
import {
  builtAt, fakeBrowserBuild, fakeDriver, projectWith, runOnTarget, targetInput, targetOf, totalCalls, trustedProjectWith,
} from './target-examples.ts';

// ---- Not in the matrix -------------------------------------------------------------------------

describe('a target that is not in the matrix', () => {
  const smallMatrix = [targetInput('chromium-desktop', 'fake-any', 'chromium', 'desktop-1280')];
  const largeMatrix = [...smallMatrix, targetInput('chromium-tablet', 'fake-any', 'chromium', 'tablet-820')];

  test('a run on a target the matrix does not declare ends TargetUnavailable with not-declared, touching no driver', { criterion: 'AC-SPEC-05-01' }, async () => {
    const runProject = projectWith(smallMatrix);
    const planProject = projectWith(largeMatrix);
    const driver = fakeDriver('fake-any');
    const ran = await runOnTarget({
      runProject, planProject, trusted: await trustedProjectWith(largeMatrix),
      planTargets: ['chromium-desktop', 'chromium-tablet'], target: targetOf(planProject, 'chromium-tablet'),
      drivers: new Map([['fake-any', driver]]),
    });
    assert.equal(ran.result.state, 'TargetUnavailable');
    assert.equal(ran.result.unavailable?.reason, 'not-declared');
    assert.equal(ran.result.targetId, 'chromium-tablet');
    assert.equal(ran.result.manifest, null);
    assert.equal(totalCalls(driver), 0, 'no driver method was called');
    assert.equal(ran.store.references().length, 0, 'nothing was stored');
  });

  test('counter-example: the same plan on a declared target does reach the driver', { criterion: 'AC-SPEC-05-01' }, async () => {
    const project = projectWith(largeMatrix);
    const driver = fakeDriver('fake-any');
    const ran = await runOnTarget({
      runProject: project, trusted: await trustedProjectWith(largeMatrix),
      planTargets: ['chromium-desktop', 'chromium-tablet'], target: targetOf(project, 'chromium-tablet'),
      drivers: new Map([['fake-any', driver]]),
    });
    assert.equal(ran.result.unavailable?.reason, 'launch-failed');
    assert.equal(driver.calls.open, 1);
  });

  test('the plan parser already rejects a plan whose target is not in the matrix, at its JSON path', { criterion: 'AC-SPEC-05-01' }, () => {
    const plan = withValue(signupPlan(), ['targets'], ['chromium-tablet']);
    const rejected = planParser(projectWith(smallMatrix))(plan);
    assert.ok(!rejected.ok);
    assert.deepEqual(rejected.error.map((error) => [error.code, error.path]), [['target_not_in_matrix', '$.targets[0]']]);
    assert.ok(planParser(projectWith(largeMatrix))(plan).ok, 'control: the same plan parses when the matrix declares the target');
  });
});

// ---- Engine not supported ----------------------------------------------------------------------

const chromiumOnly = (target: Target) =>
  (target.engine === 'chromium' ? null : { reason: 'engine-not-supported' as const, detail: 'this fake drives Chromium only' });

describe('a WebKit target that no registered adapter supports', () => {
  const matrix = [
    targetInput('webkit-desktop', 'fake-chromium', 'webkit', 'desktop-1280'),
    targetInput('chromium-desktop', 'fake-chromium', 'chromium', 'desktop-1280'),
  ];

  test('every registered adapter refuses it with engine-not-supported', { criterion: 'AC-SPEC-05-02' }, () => {
    const registry = adapterRegistry(new Map([
      ['fake-chromium', fakeDriver('fake-chromium', { refuse: chromiumOnly })],
      ['fake-chromium-too', fakeDriver('fake-chromium-too', { refuse: chromiumOnly })],
    ]));
    const webkit = targetOf(projectWith(matrix), 'webkit-desktop');
    assert.equal(registry.all().length, 2);
    for (const driver of registry.all()) {
      const answer = driver.supports(webkit);
      assert.ok(!answer.ok, `${driver.info.id} refuses WebKit`);
      assert.equal(answer.error.reason, 'engine-not-supported');
    }
  });

  test('the run ends TargetUnavailable with engine-not-supported and no other adapter runs instead', { criterion: 'AC-SPEC-05-02' }, async () => {
    const project = projectWith(matrix);
    const named = fakeDriver('fake-chromium', { refuse: chromiumOnly });
    // A registered adapter that would accept anything: a substitute, if core ever looked for one.
    const substitute = fakeDriver('fake-any');
    const ran = await runOnTarget({
      runProject: project, trusted: await trustedProjectWith(matrix), planTargets: ['webkit-desktop'],
      target: targetOf(project, 'webkit-desktop'), drivers: new Map([['fake-chromium', named], ['fake-any', substitute]]),
    });
    assert.equal(ran.result.state, 'TargetUnavailable');
    assert.equal(ran.result.unavailable?.reason, 'engine-not-supported');
    assert.equal(named.calls.open, 0, 'the named adapter opened nothing');
    assert.equal(totalCalls(substitute), 0, 'no other adapter was asked');
    assert.equal(ran.result.manifest, null);
    assert.equal(ran.store.references().length, 0);
  });

  test('counter-example: a Chromium target on the same adapter does reach open', { criterion: 'AC-SPEC-05-02' }, async () => {
    const project = projectWith(matrix);
    const named = fakeDriver('fake-chromium', { refuse: chromiumOnly });
    const ran = await runOnTarget({
      runProject: project, trusted: await trustedProjectWith(matrix), planTargets: ['chromium-desktop'],
      target: targetOf(project, 'chromium-desktop'), drivers: new Map([['fake-chromium', named]]),
    });
    assert.equal(ran.result.unavailable?.reason, 'launch-failed');
    assert.equal(named.calls.open, 1);
  });

  test('the adapter registry finds only the adapter named, and nothing for an unregistered one', { criterion: 'AC-SPEC-05-02' }, () => {
    const named = fakeDriver('fake-chromium', { refuse: chromiumOnly });
    const other = fakeDriver('fake-any');
    const registry = adapterRegistry(new Map([['fake-chromium', named], ['fake-any', other]]));
    const project = projectWith([targetInput('webkit-desktop', 'fake-webkit', 'webkit', 'desktop-1280')]);
    assert.equal(registry.find(targetOf(project, 'webkit-desktop').adapter), null);
    const fakeChromium = targetOf(projectWith(matrix), 'chromium-desktop').adapter;
    assert.equal(registry.find(fakeChromium), named);
    assert.deepEqual(registry.all().map((driver) => driver.info.id).sort(), ['fake-any', 'fake-chromium']);
  });
});

// ---- Device not supported ----------------------------------------------------------------------

const noMobileFirefox = (target: Target) =>
  (target.engine === 'firefox' && (target.device === 'phone-390' || target.device === 'tablet-820')
    ? { reason: 'device-not-supported' as const, detail: 'this fake cannot emulate a mobile device in Firefox' } : null);

describe('a Firefox target with a phone profile', () => {
  const matrix = [
    targetInput('firefox-phone', 'fake-firefox', 'firefox', 'phone-390'),
    targetInput('firefox-desktop', 'fake-firefox', 'firefox', 'desktop-1280'),
  ];

  test('the run ends device-not-supported rather than running on desktop, and no other adapter is tried', { criterion: 'AC-SPEC-05-03' }, async () => {
    const project = projectWith(matrix);
    const named = fakeDriver('fake-firefox', { refuse: noMobileFirefox });
    const substitute = fakeDriver('fake-any');
    const ran = await runOnTarget({
      runProject: project, trusted: await trustedProjectWith(matrix), planTargets: ['firefox-phone'],
      target: targetOf(project, 'firefox-phone'), drivers: new Map([['fake-firefox', named], ['fake-any', substitute]]),
    });
    assert.equal(ran.result.state, 'TargetUnavailable');
    assert.equal(ran.result.unavailable?.reason, 'device-not-supported');
    assert.equal(ran.result.targetId, 'firefox-phone');
    assert.equal(named.calls.supports, 1, 'the named adapter was asked once');
    assert.equal(named.calls.open, 0, 'nothing opened, on desktop or any other device');
    assert.equal(totalCalls(substitute), 0, 'no other adapter was tried');
    assert.equal(ran.result.manifest, null);
    assert.deepEqual(ran.result.steps, []);
    assert.equal(ran.store.references().length, 0);
  });

  test('counter-example: the same adapter does open a Firefox desktop target', { criterion: 'AC-SPEC-05-03' }, async () => {
    const project = projectWith(matrix);
    const named = fakeDriver('fake-firefox', { refuse: noMobileFirefox });
    const ran = await runOnTarget({
      runProject: project, trusted: await trustedProjectWith(matrix), planTargets: ['firefox-desktop'],
      target: targetOf(project, 'firefox-desktop'), drivers: new Map([['fake-firefox', named]]),
    });
    assert.equal(ran.result.unavailable?.reason, 'launch-failed');
    assert.equal(named.calls.open, 1);
  });
});

// ---- Build mismatch at run time ----------------------------------------------------------------

describe('a browser build that differs from the lockfile at run time', () => {
  const matrix = [targetInput('pinned-chromium', 'fake-chromium', 'chromium', 'desktop-1280')];
  const build = fakeBrowserBuild('chromium build 156.0.7258.5');
  after(() => build.remove());

  const runPinned = async (executableSha256: string | null) => {
    const project = projectWith(matrix);
    const target = targetOf(project, 'pinned-chromium');
    const driver = fakeDriver('fake-chromium', { build: () => builtAt('156.0.7258.5', build) });
    const ran = await runOnTarget({
      runProject: project, trusted: await trustedProjectWith(matrix), planTargets: ['pinned-chromium'], target,
      drivers: new Map([['fake-chromium', driver]]),
      ...(executableSha256 === null ? {} : { lockEntries: [{ targetId: target.id, version: '156.0.7258.5', executableSha256 }] }),
    });
    return { ...ran, driver };
  };

  test('the target is unavailable with build-mismatch and no browser opens', { criterion: 'AC-SPEC-05-04' }, async () => {
    const ran = await runPinned('0'.repeat(64));
    assert.equal(ran.result.state, 'TargetUnavailable');
    assert.equal(ran.result.unavailable?.reason, 'build-mismatch');
    assert.equal(ran.driver.calls.open, 0, 'the build was hashed before open, and open was never called');
    assert.equal(ran.result.manifest, null);
    assert.equal(ran.store.references().length, 0);
  });

  test('counter-example: the hash the lockfile holds lets the run reach open', { criterion: 'AC-SPEC-05-04' }, async () => {
    const ran = await runPinned(build.sha256());
    assert.equal(ran.result.unavailable?.reason, 'launch-failed');
    assert.equal(ran.driver.calls.open, 1);
  });

  test('a run given no lock entries behaves as before and reaches open', { criterion: 'AC-SPEC-05-04' }, async () => {
    const ran = await runPinned(null);
    assert.equal(ran.result.unavailable?.reason, 'launch-failed');
    assert.equal(ran.driver.calls.open, 1);
  });

  test('a build whose bytes change after locking makes the target unavailable', { criterion: 'AC-SPEC-05-04' }, async () => {
    const changing = fakeBrowserBuild('chromium build 156.0.7258.5');
    try {
      const pinnedHash = changing.sha256();
      changing.replaceBytes('chromium build 156.0.7258.5, patched in place');
      const project = projectWith(matrix);
      const target = targetOf(project, 'pinned-chromium');
      const driver = fakeDriver('fake-chromium', { build: () => builtAt('156.0.7258.5', changing) });
      const ran = await runOnTarget({
        runProject: project, trusted: await trustedProjectWith(matrix), planTargets: ['pinned-chromium'], target,
        drivers: new Map([['fake-chromium', driver]]),
        lockEntries: [{ targetId: target.id, version: '156.0.7258.5', executableSha256: pinnedHash }],
      });
      assert.equal(ran.result.unavailable?.reason, 'build-mismatch');
      assert.equal(driver.calls.open, 0);
    } finally {
      changing.remove();
    }
  });
});
