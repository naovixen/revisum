// Key chords and multi-line fills in a real browser, on the own CDP driver.
// A press with modifiers holds them down in the order written, presses the key, then releases
// them in reverse; the key sees them held. The fixture page (fixtures/plan-values-app/keys.html)
// logs every key event the editor receives, in the format keys.js describes. ControlOrMeta is
// pressed as Control on the Windows and Linux machines this suite runs on; its macOS mapping is
// checked without a browser in test/unit/driver-cdp/modifier-keys.test.ts.
// The runtime guard treats Control+Enter and Shift+Enter as Enter: in a form whose submit control
// is irreversible the run ends Denied with nothing sent (fixtures/plan-values-app/forms.html).
// A multi-line fill leaves the field holding its lines joined by line feeds, inserted as text, so
// a chat box that sends on Enter (fixtures/plan-values-app/message.html) never sends early.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { platform } from 'node:os';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGET, fill, label, navigate, outcomes, planValuesHarness, press, reference, remember, testId, textEquals,
  type PlanValuesHarness,
} from './plan-values-support.ts';

let harness: PlanValuesHarness;
before(async () => { harness = await planValuesHarness(); });
after(async () => { await harness.close(); });

describe('key chords', () => {
  const OPEN_PAGE = navigate('/keys.html');
  const editor = label('Editor');
  const chordLogged = async (key: string, modifiers: readonly string[] | undefined, expectedLog: string): Promise<void> => {
    const { result } = await harness.runSteps(CDP_TARGET, [OPEN_PAGE, press(editor, key, modifiers), textEquals(testId('key-log'), expectedLog, 'keys.chord-logged')]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  };

  test('Shift, Alt and Control go down in the order written, then the key, then come up in reverse', { criterion: 'AC-SPEC-30-14' }, async () => {
    await chordLogged('k', ['Shift', 'Alt', 'Control'],
      'down:Shift down:Alt down:Control down:KeyK[Alt+Control+Shift] up:KeyK[Alt+Control+Shift] up:Control up:Alt up:Shift');
  });

  // The relation between the two runs: reversing the plan's modifiers reverses the presses, so the
  // order comes from the plan and not from a fixed order in the driver.
  test('the same modifiers written in reverse are pressed and released in reverse', { criterion: 'AC-SPEC-30-14' }, async () => {
    await chordLogged('k', ['Control', 'Alt', 'Shift'],
      'down:Control down:Alt down:Shift down:KeyK[Alt+Control+Shift] up:KeyK[Alt+Control+Shift] up:Shift up:Alt up:Control');
  });

  test('a punctuation key can be pressed with a modifier', { criterion: 'AC-SPEC-30-14' }, async () => {
    await chordLogged('Backquote', ['Control'], 'down:Control down:Backquote[Control] up:Backquote[Control] up:Control');
  });

  // Counter-example: a press without modifiers holds none, so the brackets above show held keys.
  test('counter-example: a press without modifiers holds none', { criterion: 'AC-SPEC-30-14' }, async () => {
    await chordLogged('k', undefined, 'down:KeyK[] up:KeyK[]');
  });

  test('ControlOrMeta is pressed as Control on Windows and Linux', {
    criterion: 'AC-SPEC-30-14', skip: platform() === 'darwin' ? 'on macOS ControlOrMeta is Meta; the unit test checks that mapping' : false,
  }, async () => {
    await chordLogged('k', ['ControlOrMeta', 'Shift'], 'down:Control down:Shift down:KeyK[Control+Shift] up:KeyK[Control+Shift] up:Shift up:Control');
  });
});

describe('key chords and the runtime guard', () => {
  const OPEN_PAGE = navigate('/forms.html');
  const READ_AT_CLOSE = ['input-events', 'reason-enters', 'submitted'];

  for (const modifier of ['Control', 'Shift']) {
    test(`${modifier}+Enter in a form whose submit control is "Delete account" ends the run Denied with nothing sent`, { criterion: 'AC-SPEC-30-15' }, async () => {
      const { result, atClose } = await harness.runSteps(CDP_TARGET, [
        OPEN_PAGE, press(label('Reason'), 'Enter', [modifier]), textEquals(testId('submitted'), 'nothing', 'forms.nothing-submitted'),
      ], { read: READ_AT_CLOSE });
      assert.equal(result.state, 'Denied', JSON.stringify(result.steps));
      assert.deepEqual(result.denial, { rule: 'irreversible-submit', stepIndex: 1 });
      assert.equal(result.steps[1]?.code, 'policy-denied');
      assert.equal(atClose?.shown['input-events'], '0', 'no input event reached the page, not even the modifier');
      assert.equal(atClose?.shown['reason-enters'], '0');
      assert.equal(atClose?.shown['submitted'], 'nothing');
    });

    // Counter-example: the same chord in a form whose submit control is not irreversible reaches
    // the page, so the counters can move and the denial above is the guard's doing.
    test(`counter-example: ${modifier}+Enter in a form whose submit control is "Update profile" reaches the page`, { criterion: 'AC-SPEC-30-15' }, async () => {
      const { result, atClose } = await harness.runSteps(CDP_TARGET, [
        OPEN_PAGE, press(label('Nickname'), 'Enter', [modifier]), textEquals(testId('nickname-enters'), '1', 'forms.enter-reached'),
      ]);
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.notEqual(atClose?.shown['input-events'], '0');
    });
  }
});

describe('multi-line fills', () => {
  const OPEN_PAGE = navigate('/message.html');
  const message = label('Message');

  test('a three-line fill leaves the field holding the lines joined by line feeds, with no Enter key event', { criterion: 'AC-SPEC-30-16' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      OPEN_PAGE,
      fill(message, { lines: ['Hello there', 'Second line', 'Third: done'] }),
      // The page shows the value as a JSON string, so each line feed reads as \n.
      textEquals(testId('message-json'), '"Hello there\\nSecond line\\nThird: done"', 'message.lines-joined'),
      textEquals(testId('message-lines'), '3', 'message.three-lines'),
      textEquals(testId('enter-presses'), '0', 'message.no-enter'),
      textEquals(testId('sent'), 'not sent', 'message.not-sent'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('a line that is a remembered value is filled with that value\'s text', { criterion: 'AC-SPEC-30-16' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      OPEN_PAGE,
      remember('orderNumber', testId('order-number')),
      fill(message, { lines: ['Order', reference('orderNumber')] }),
      textEquals(testId('message-json'), '"Order\\nORD-58213"', 'message.order-line-filled'),
      textEquals(testId('enter-presses'), '0', 'message.no-enter'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('a multi-line fill replaces what the field held before', { criterion: 'AC-SPEC-30-16' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      OPEN_PAGE,
      fill(message, 'Draft to replace'),
      fill(message, { lines: ['First', 'Second'] }),
      textEquals(testId('message-json'), '"First\\nSecond"', 'message.replaced'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  // Counter-example: pressing Enter in the box does count and send, so the checks above that no
  // Enter arrived can fail.
  test('counter-example: pressing Enter in the message box counts and sends it', { criterion: 'AC-SPEC-30-16' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      OPEN_PAGE,
      fill(message, 'Hello there'),
      press(message, 'Enter'),
      textEquals(testId('enter-presses'), '1', 'message.enter-counted'),
      textEquals(testId('sent'), 'sent: Hello there', 'message.sent'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.deepEqual(outcomes(result).map(([, outcome]) => outcome), ['passed', 'passed', 'passed', 'passed', 'passed']);
  });
});
