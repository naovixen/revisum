// Both real drivers honour the policy gate's runtime guard. Given a guard, a driver resolves the
// step's element, asks the guard with the element as the page shows it, and sends input only on
// an allow. On a deny the step ends with policy-denied and the page receives no input event at
// all: the fixture page (fixtures/capability-app/guard.html) counts every press, click, key and
// value change, whoever sends it. A dialog step asks the guard with the dialog's text and an
// element whose every field is null.
// Each deny is paired with the same step allowed, which does reach the page, so the counters are
// shown able to move. A run through the real policy gate then shows a control whose test id hides
// an irreversible name ending the run Denied, with nothing sent.
// Every test opens its own browser, so no mouse position or open dialog carries over.
// See docs/specs/SPEC-06-cdp-driver.md and docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ActionGuard, GuardVerdict, ResolvedElement, Session } from '@revisum/engine';
import {
  CDP_TARGET, PLAYWRIGHT_TARGET, UPLOAD_FIXTURE, capabilityCdpDriver, capabilityDrivers, capabilityHarness, capabilityPlan, click,
  label, navigate, role, shownText, testId, textEquals, watchedDriver, type CapabilityHarness,
} from '../support/capability-harness.ts';
import { BROWSERS } from '../support/browsers.ts';

let capability: CapabilityHarness;
before(async () => { capability = await capabilityHarness(2000); });
after(async () => { await capability.close(); });

const ALLOW: GuardVerdict = { kind: 'allow' };
const DENY: GuardVerdict = { kind: 'deny', rule: 'irreversible-action', stepIndex: 1 };

type GuardCall = { readonly element: ResolvedElement; readonly dialogText: string | null };
// A guard that answers with the given verdict and keeps every question it was asked.
function spyGuard(verdict: GuardVerdict): { readonly guard: ActionGuard; readonly calls: GuardCall[] } {
  const calls: GuardCall[] = [];
  return { calls, guard: (element, dialogText) => { calls.push({ element, dialogText }); return verdict; } };
}

const withGuardPage = async <Value>(targetId: string, use: (session: Session) => Promise<Value>): Promise<Value> => {
  const session = await capability.open(targetId);
  try {
    assert.ok((await session.navigate(capability.url('/guard.html'))).ok, 'the guard page loads');
    return await use(session);
  } finally {
    await session.close();
  }
};

// One kind of action step: the raw step, what the guard should be told about its element, and
// how the page shows the step's effect: untouched, and once the step has run.
type GuardedAction = {
  readonly name: string;
  readonly step: object;
  readonly element: Partial<ResolvedElement>;
  readonly effect: { readonly read: (session: Session) => Promise<string>; readonly untouched: string; readonly done: string };
};

const shown = (id: string) => (session: Session): Promise<string> => shownText(capability, session, id);
const noteValue = async (session: Session): Promise<string> => (await session.probe(capability.locator(label('Note')))).value ?? '';

const BOTH_DRIVERS: readonly GuardedAction[] = [
  { name: 'click', step: click(role('button', 'Save draft')), element: { role: 'button', name: 'Save draft' }, effect: { read: shown('save-clicks'), untouched: '0', done: '1' } },
  {
    name: 'fill', step: { type: 'fill', locator: label('Note'), value: 'Remember the milk' }, element: { role: 'textbox', name: 'Note' },
    effect: { read: noteValue, untouched: '', done: 'Remember the milk' },
  },
  {
    name: 'press', step: { type: 'press', locator: label('Note'), key: 'Enter' }, element: { role: 'textbox', name: 'Note' },
    effect: { read: shown('note-keys'), untouched: '0', done: '1' },
  },
];

// Steps the own CDP driver performs and the Playwright fallback refuses.
const CDP_ONLY: readonly GuardedAction[] = [
  { name: 'hover', step: { type: 'hover', locator: role('button', 'Help') }, element: { role: 'button', name: 'Help' }, effect: { read: shown('help-state'), untouched: 'closed', done: 'open' } },
  {
    name: 'select', step: { type: 'select', locator: label('Size'), option: 'Large' }, element: { role: 'combobox', name: 'Size' },
    effect: { read: shown('size-chosen'), untouched: 'Small', done: 'Large' },
  },
  {
    name: 'upload', step: { type: 'upload', locator: label('Attachment'), fixture: UPLOAD_FIXTURE }, element: { name: 'Attachment' },
    effect: { read: shown('attachment-name'), untouched: 'none', done: UPLOAD_FIXTURE },
  },
];

const DRIVERS = [
  { targetId: CDP_TARGET, actions: [...BOTH_DRIVERS, ...CDP_ONLY] },
  { targetId: PLAYWRIGHT_TARGET, actions: BOTH_DRIVERS },
] as const;

for (const { targetId, actions } of DRIVERS) {
  describe(`the runtime guard on ${targetId}`, () => {
    for (const action of actions) {
      test(`a denied ${action.name} ends with policy-denied and sends no input event`, { criterion: 'AC-SPEC-06-09' }, async () => {
        const { guard, calls } = spyGuard(DENY);
        await withGuardPage(targetId, async (session) => {
          const acted = await session.act(capability.actionStep(action.step), guard);
          assert.equal(acted.ok ? 'passed' : acted.error.code, 'policy-denied');
          assert.equal(await shownText(capability, session, 'input-events'), '0', 'no input event reached the page');
          assert.equal(await action.effect.read(session), action.effect.untouched);
        });
        assert.equal(calls.length, 1, 'the guard was asked once');
      });

      test(`the guard is told the resolved element of the ${action.name} step`, { criterion: 'AC-SPEC-06-09' }, async () => {
        const { guard, calls } = spyGuard(DENY);
        await withGuardPage(targetId, async (session) => { await session.act(capability.actionStep(action.step), guard); });
        const asked = calls[0];
        assert.ok(asked !== undefined, 'the guard was asked');
        for (const [field, value] of Object.entries(action.element)) assert.equal(asked.element[field as keyof ResolvedElement], value, field);
        assert.ok(asked.element.box !== null && asked.element.box.width > 0 && asked.element.box.height > 0, 'the element was resolved on the page');
        assert.equal(asked.element.formSubmitName, null, 'the control is outside any form');
        assert.equal(asked.dialogText, null);
      });

      test(`counter-example: an allowed ${action.name} reaches the page`, { criterion: 'AC-SPEC-06-09' }, async () => {
        const { guard, calls } = spyGuard(ALLOW);
        await withGuardPage(targetId, async (session) => {
          const acted = await session.act(capability.actionStep(action.step), guard);
          assert.ok(acted.ok, acted.ok ? '' : `${acted.error.code}: ${acted.error.detail}`);
          assert.equal(await action.effect.read(session), action.effect.done);
        });
        assert.equal(calls.length, 1);
      });
    }

    test('an element that is never found is not passed to the guard', { criterion: 'AC-SPEC-06-09' }, async () => {
      const { guard, calls } = spyGuard(ALLOW);
      await withGuardPage(targetId, async (session) => {
        const acted = await session.act(capability.actionStep(click(role('button', 'Does not exist'))), guard);
        assert.equal(acted.ok ? 'passed' : acted.error.code, 'not-found');
      });
      assert.equal(calls.length, 0);
    });
  });
}

describe(`the runtime guard on dialogs: ${CDP_TARGET}`, () => {
  test('a denied dialog answer ends with policy-denied; the guard gets the dialog text and an empty element', { criterion: 'AC-SPEC-06-09' }, async () => {
    const { guard, calls } = spyGuard({ kind: 'deny', rule: 'irreversible-dialog', stepIndex: 2 });
    await withGuardPage(CDP_TARGET, async (session) => {
      assert.ok((await session.act(capability.actionStep(click(role('button', 'Ask a question'))))).ok, 'the click opens the dialog');
      const answered = await session.act(capability.actionStep({ type: 'dialog', action: 'accept', expectText: 'Keep the draft?' }), guard);
      assert.equal(answered.ok ? 'passed' : answered.error.code, 'policy-denied');
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { element: { role: null, name: null, box: null, formSubmitName: null, linkUrl: null }, dialogText: 'Keep the draft?' });
  });

  test('counter-example: an allowed dialog answer accepts the dialog', { criterion: 'AC-SPEC-06-09' }, async () => {
    const { guard, calls } = spyGuard(ALLOW);
    await withGuardPage(CDP_TARGET, async (session) => {
      assert.ok((await session.act(capability.actionStep(click(role('button', 'Ask a question'))))).ok);
      const answered = await session.act(capability.actionStep({ type: 'dialog', action: 'accept', expectText: 'Keep the draft?' }), guard);
      assert.ok(answered.ok, answered.ok ? '' : `${answered.error.code}: ${answered.error.detail}`);
      assert.equal(await shownText(capability, session, 'dialog-status'), 'Kept');
    });
    assert.equal(calls[0]?.dialogText, 'Keep the draft?');
  });
});

describe(`the real policy gate, through a run: ${CDP_TARGET}`, () => {
  // Reads the page's input-event count just before the run closes the session.
  const runReadingInputEvents = async (steps: readonly unknown[]) => {
    const watched = watchedDriver(capabilityCdpDriver(BROWSERS.chrome), (session) => shownText(capability, session, 'input-events'));
    const drivers = new Map([...capabilityDrivers(), ['cdp', watched.driver]]);
    const ran = await capability.run(capability.plan(capabilityPlan(CDP_TARGET, steps)), CDP_TARGET, drivers);
    return { ...ran, inputEvents: watched.sessions[0]?.readBeforeClose ?? null };
  };

  test('a click on a control named "Delete account" ends the run Denied with nothing sent', { criterion: 'AC-SPEC-06-09' }, async () => {
    const { result, inputEvents } = await runReadingInputEvents([
      navigate('/guard.html'),
      click(testId('close-account')),
      textEquals(testId('input-events'), '0', 'guard.nothing-sent'),
    ]);
    assert.equal(result.state, 'Denied');
    assert.deepEqual(result.denial, { rule: 'irreversible-action', stepIndex: 1 });
    assert.equal(result.steps[1]?.code, 'policy-denied');
    assert.equal(inputEvents, '0');
  });

  test('counter-example: the same run clicking "Save draft" passes and sends the click', { criterion: 'AC-SPEC-06-09' }, async () => {
    const { result, inputEvents } = await runReadingInputEvents([
      navigate('/guard.html'),
      click(role('button', 'Save draft')),
      textEquals(testId('save-clicks'), '1', 'guard.saved'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.notEqual(inputEvents, '0');
  });

  test('accepting a dialog whose text is irreversible ends the run Denied', { criterion: 'AC-SPEC-06-09' }, async () => {
    const { result } = await runReadingInputEvents([
      navigate('/guard.html'),
      click(role('button', 'Clear drafts')),
      { type: 'dialog', action: 'accept' },
      textEquals(testId('dialog-status'), 'Cleared', 'guard.cleared'),
    ]);
    assert.equal(result.state, 'Denied');
    assert.deepEqual(result.denial, { rule: 'irreversible-dialog', stepIndex: 2 });
    assert.equal(result.steps[2]?.code, 'policy-denied');
  });
});
