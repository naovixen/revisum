// The run's clipboard is the browser's own, never the host's. With a canary on the host's
// clipboard, a run on each own CDP target sees an empty clipboard: a remember from it fails with
// value-empty and a check for the canary fails as "empty". After the page copies, the run's checks
// see the copy, and the host's clipboard still holds the canary.
// The host's clipboard is the system clipboard on Windows, saved first and always restored, and
// on Linux the clipboard of a private virtual display the test starts (see host-clipboard.ts).
// Elsewhere, or when the Windows clipboard holds data that cannot be saved whole, the test is
// skipped with the reason.
// A browser build that cannot keep the clipboard in memory is stood in for by a session whose
// clipboard port answers clipboard-unavailable: every clipboard step then fails with that code,
// and the run stops there. The counter-example runs the same steps on the unchanged driver.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGET, CDP_TARGETS, INVITE_CODE, click, clockHarness, expectClipboard, navigate, outcomes, portWith, rememberClipboard, role, sessionWith,
  testId, textEquals, wrappingSessions, type ClockHarness, type JsonRecord,
} from '../contract/clock-and-clipboard-support.ts';
import { openHostClipboard, type HostClipboard } from '../contract/host-clipboard.ts';

const TIMEOUT = 300_000;

let harness: ClockHarness;
before(async () => { harness = await clockHarness(); });
after(async () => { await harness.close(); });

const copyInviteCode = click(role('button', 'Copy invite code'));
const continueStep = click(role('button', 'Continue'));
// A check that follows a clipboard step, so a plan whose only other step is a remember still
// asserts something; it is skipped once the step before it fails.
const nothingCopied = textEquals(testId('copy-state'), 'Nothing copied', 'host.nothing-copied');

describe('a canary on the host\'s clipboard', () => {
  let hostClipboard: HostClipboard;
  let canary: string;
  before(async () => {
    hostClipboard = await openHostClipboard();
    canary = `HostCanary${randomBytes(6).toString('hex')}`;
  });
  after(async () => { await hostClipboard.restore(); });

  for (const targetId of CDP_TARGETS) {
    test(`on ${targetId}, the plan sees an empty clipboard, and the canary is still on the host's clipboard after the page copies`, { criterion: 'AC-SPEC-34-16', timeout: TIMEOUT }, async (context) => {
      if (hostClipboard.unavailableReason !== null) { context.skip(hostClipboard.unavailableReason); return; }
      await hostClipboard.write(canary);
      assert.equal(await hostClipboard.read(), canary, 'the canary is on the host\'s clipboard before the run');

      // The run's clipboard starts empty: a remember from it has nothing to read.
      const remembering = await harness.runSteps(targetId, [navigate('/clipboard.html'), rememberClipboard('hostText'), nothingCopied]);
      assert.deepEqual(outcomes(remembering.result), [[0, 'passed', undefined], [1, 'failed', 'value-empty'], [2, 'skipped', undefined]], JSON.stringify(remembering.result.steps));

      // A check for the canary fails, and says only that the clipboard is empty.
      const checking = await harness.runSteps(targetId, [navigate('/clipboard.html'), expectClipboard('textContains', canary, 'host.canary-seen')]);
      assert.deepEqual(outcomes(checking.result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed']], JSON.stringify(checking.result.steps));
      assert.equal(checking.result.steps[1]?.observed ?? 'empty', 'empty');

      // The page copies: the run sees the copy, and not the canary.
      const copied = await harness.runSteps(targetId, [
        navigate('/clipboard.html'),
        copyInviteCode,
        expectClipboard('textEquals', INVITE_CODE, 'host.copy-seen'),
        expectClipboard('textExcludes', canary, 'host.canary-absent'),
      ]);
      assert.equal(copied.result.state, 'Passed', JSON.stringify(copied.result.steps));

      assert.equal(await hostClipboard.read(), canary, 'the canary is still on the host\'s clipboard');
    });
  }

  // Counter-example: the host's clipboard as the test reads it does change when written, so the
  // check above that the canary is still there can fail.
  test('counter-example: a write to the host\'s clipboard is seen by the next read', { criterion: 'AC-SPEC-34-16' }, async (context) => {
    if (hostClipboard.unavailableReason !== null) { context.skip(hostClipboard.unavailableReason); return; }
    await hostClipboard.write(canary);
    await hostClipboard.write(INVITE_CODE);
    assert.equal(await hostClipboard.read(), INVITE_CODE);
  });
});

describe('a browser build that cannot keep the clipboard in memory', () => {
  // The own CDP driver, its sessions' clipboard ports answering clipboard-unavailable to every read.
  const withoutMemoryClipboard = () => {
    const inner = harness.drivers.get('cdp');
    assert.ok(inner !== undefined);
    const unavailable = async () => ({ ok: false as const, error: { code: 'clipboard-unavailable' as const, detail: 'this build has no in-memory clipboard' } });
    const driver = wrappingSessions(inner, (session) => sessionWith(session, {
      clipboard: portWith(Reflect.get(session, 'clipboard', session), { readText: unavailable }),
    }));
    return new Map([...harness.drivers, ['cdp', driver]]);
  };

  const CLIPBOARD_STEPS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: 'an expectClipboard with textEquals', step: expectClipboard('textEquals', INVITE_CODE, 'unavailable.equals') },
    { name: 'an expectClipboard with textContains', step: expectClipboard('textContains', 'HX-4471', 'unavailable.contains') },
    { name: 'an expectClipboard with textExcludes', step: expectClipboard('textExcludes', 'password', 'unavailable.excludes') },
    { name: 'a remember from the clipboard', step: rememberClipboard('inviteCode') },
  ];

  for (const { name, step } of CLIPBOARD_STEPS) {
    test(`${name} fails with clipboard-unavailable, and the rest of the run is skipped`, { criterion: 'AC-SPEC-34-16' }, async () => {
      const ran = await harness.runSteps(CDP_TARGET, [navigate('/clipboard.html'), step, continueStep, nothingCopied], {
        drivers: withoutMemoryClipboard(), read: ['continue-state'],
      });
      assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'clipboard-unavailable'], [2, 'skipped', undefined], [3, 'skipped', undefined]], JSON.stringify(ran.result.steps));
      assert.equal(ran.atClose?.shown['continue-state'], 'Not continued');
    });
  }

  // No copy is needed: a remember of the empty clipboard fails with value-empty, not
  // clipboard-unavailable, on the driver as it is.
  test('counter-example: on the unchanged driver, the same remember reaches the clipboard and finds it empty', { criterion: 'AC-SPEC-34-16' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [navigate('/clipboard.html'), rememberClipboard('inviteCode'), continueStep, nothingCopied]);
    assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'value-empty'], [2, 'skipped', undefined], [3, 'skipped', undefined]], JSON.stringify(ran.result.steps));
  });

  test('counter-example: on the unchanged driver, a check of the empty clipboard fails as a check, not as clipboard-unavailable', { criterion: 'AC-SPEC-34-16' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [navigate('/clipboard.html'), expectClipboard('textExcludes', 'password', 'unavailable.empty-check')]);
    assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed']], JSON.stringify(ran.result.steps));
  });
});

