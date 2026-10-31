// What a page script's result may be, on both drivers. The declared script hostileResult
// (fixtures/unsafe-features-project/plans/scripts/) returns, throws or hangs as its `kind` argument
// asks; its declaration sets a 1,024-byte result limit and a 1-second timeout.
//   - over maximumResultBytes: script-result-too-large (the engine decodes the result text);
//   - nested deeper than 64: script-result-invalid (the engine's decoder);
//   - cyclic, undefined or a function: script-result-invalid (the driver cannot make JSON of it);
//   - a throw or a rejected promise: script-failed;
//   - a promise that never settles: script-timeout, after the script's own timeout, not the step's.
// Each is an evaluate step, so the run ends Errored, the later steps are skipped and the page gets
// no more input. The counter-examples run the same script with a result just inside each limit,
// and a plain result, and pass.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  BOTH_TARGETS, HOSTILE_RESULT_MAXIMUM_BYTES, HOSTILE_RESULT_TIMEOUT_MILLISECONDS, STEP_TIMEOUT_MILLISECONDS, continueStep, continued, hostileResult,
  navigate, outcomes, stepMilliseconds, unsafePageHarness, type HostileResultKind, type UnsafePageHarness,
} from './unsafe-page-support.ts';

let harness: UnsafePageHarness;
before(async () => { harness = await unsafePageHarness(); });
after(async () => { await harness.close(); });

// The result text of a sized result is {"shape":"sized","padding":"…"}: 30 bytes plus the padding.
const SIZED_OVERHEAD_BYTES = '{"shape":"sized","padding":""}'.length;
// A nested result is the outer object plus `amount` arrays.
const DEPTH_LIMIT = 64;

type Refused = { readonly name: string; readonly kind: HostileResultKind; readonly amount: number; readonly code: string };
const REFUSED: readonly Refused[] = [
  { name: 'a result over maximumResultBytes', kind: 'sized', amount: 2 * HOSTILE_RESULT_MAXIMUM_BYTES, code: 'script-result-too-large' },
  { name: 'a result nested past the depth limit', kind: 'nested', amount: DEPTH_LIMIT + 6, code: 'script-result-invalid' },
  { name: 'a cyclic result', kind: 'cyclic', amount: 0, code: 'script-result-invalid' },
  { name: 'an undefined result', kind: 'undefined', amount: 0, code: 'script-result-invalid' },
  { name: 'a function as the result', kind: 'function', amount: 0, code: 'script-result-invalid' },
  { name: 'a throw', kind: 'throws', amount: 0, code: 'script-failed' },
  { name: 'a rejected promise', kind: 'rejects', amount: 0, code: 'script-failed' },
  { name: 'a promise that never settles', kind: 'never-settles', amount: 0, code: 'script-timeout' },
];

const ACCEPTED: readonly { readonly name: string; readonly kind: HostileResultKind; readonly amount: number }[] = [
  { name: 'a plain result', kind: 'plain', amount: 0 },
  { name: 'a result just under maximumResultBytes', kind: 'sized', amount: HOSTILE_RESULT_MAXIMUM_BYTES - SIZED_OVERHEAD_BYTES - 24 },
  { name: 'a result nested well inside the depth limit', kind: 'nested', amount: DEPTH_LIMIT - 14 },
];

// Open the page, run the script, then send input and check the page. Nothing before the script
// sends input, so a failed script leaves the input counter at 0.
const scriptThenContinue = (kind: HostileResultKind, amount: number): unknown[] =>
  [navigate('/'), hostileResult(kind, amount), continueStep(), continued()];

for (const targetId of BOTH_TARGETS) {
  describe(`page script results: ${targetId}`, () => {
    for (const { name, kind, amount, code } of REFUSED) {
      test(`${name} fails the evaluate step with ${code}, ends the run Errored and skips the rest`, { criterion: 'AC-SPEC-36-10' }, async () => {
        const ran = await harness.runSteps(targetId, scriptThenContinue(kind, amount), { read: ['input-events', 'continue-state'] });
        assert.equal(ran.result.state, 'Errored', JSON.stringify(ran.result.steps));
        assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', code], [2, 'skipped', undefined], [3, 'skipped', undefined]]);
        assert.equal(ran.atClose?.shown['input-events'], '0', 'no input event reached the page');
        assert.equal(ran.atClose?.shown['continue-state'], 'Not continued');
      });
    }

    test('a promise that never settles is stopped by the script\'s own timeout, well before the step timeout', { criterion: 'AC-SPEC-36-10' }, async () => {
      const ran = await harness.runSteps(targetId, scriptThenContinue('never-settles', 0));
      assert.equal(ran.result.steps[1]?.code, 'script-timeout');
      const taken = stepMilliseconds(ran.result, 1);
      assert.ok(taken >= HOSTILE_RESULT_TIMEOUT_MILLISECONDS * 0.9, `the script was given its full timeout: ${taken} ms`);
      assert.ok(taken < STEP_TIMEOUT_MILLISECONDS * 0.8, `the script's timeout, not the step's, stopped it: ${taken} ms`);
    });

    // Counter-examples: the same script, with results inside every limit, passes, and the page
    // then receives the click.
    for (const { name, kind, amount } of ACCEPTED) {
      test(`counter-example: ${name} passes and the run goes on`, { criterion: 'AC-SPEC-36-10' }, async () => {
        const ran = await harness.runSteps(targetId, scriptThenContinue(kind, amount), { read: ['input-events'] });
        assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
        assert.notEqual(ran.atClose?.shown['input-events'], '0', 'the click after the script reached the page');
      });
    }
  });
}
