// The real driver honours the policy gate's runtime guard. Given a guard, a driver resolves the
// step's element, asks the guard with the element as the page shows it, and sends input only on
// an allow. On a deny the step ends with policy-denied and the page receives no input event at
// all: the fixture page (test/fixtures/sites/capability-app/guard.html) counts every press, click, key and
// value change, whoever sends it. A dialog step asks the guard with the dialog's text and an
// element whose every field is null.
// Each deny is paired with the same step allowed, which does reach the page, so the counters are
// shown able to move. A run through the real policy gate then shows a control whose test id hides
// an irreversible name ending the run Denied, with nothing sent.
// Every test opens its own browser, so no mouse position or open dialog carries over.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { ActionGuard, GuardVerdict, ResolvedElement, Session } from '@revisum/engine';
import { allowEveryAction } from '#test-support/browser/AllowEveryAction.ts';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { expectOneElement } from '#test-support/browser/ExpectOneElement.ts';
import { click, label, navigate, role, testId, textEquals, type JsonRecord } from '#test-support/browser/RawPlan.ts';
import { UPLOAD_FIXTURE, capabilityCdpDriver, capabilityDrivers, capabilityHarness, capabilityPlan, shownText, watchedDriver, type CapabilityHarness } from '#test-support/browser/harnesses/CapabilityHarness.ts';
import { BROWSERS } from '#test-support/browser/Browsers.ts';
import { shareBrowserInThisFile } from '#test-support/browser/ShareBrowserInThisFile.ts';
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { PolicyRuleId, PolicyVerdictKind } from '@revisum/contracts';

shareBrowserInThisFile();

let capability: CapabilityHarness;
before(async () => { capability = await capabilityHarness(2000); });
after(async () => { await capability.close(); });

const ALLOW: GuardVerdict = { kind: PolicyVerdictKind.Allow };
const DENY: GuardVerdict = { kind: PolicyVerdictKind.Deny, rule: PolicyRuleId.IrreversibleAction, stepIndex: 1 };

type GuardCall = { readonly element: ResolvedElement; readonly dialogText: string | null };
// A guard that answers with the given verdict and keeps every question it was asked.
function spyGuard(verdict: GuardVerdict): { readonly guard: ActionGuard; readonly calls: GuardCall[] } {
  const calls: GuardCall[] = [];
  return { calls, guard: (element, dialogText) => { calls.push({ element, dialogText }); return verdict; } };
}

const withGuardPage = async <Value>(targetId: string, use: (session: Session) => Promise<Value>): Promise<Value> => {
  const session = await capability.open(targetId);
  try {
    assert.ok((await session.navigate(capability.url('/guard.html'), scriptsEnabled)).ok, 'the guard page loads');
    return await use(session);
  } finally {
    await session.close();
  }
};

// One kind of action step: the raw step, what the guard should be told about its element, and
// how the page shows the step's effect: untouched, and once the step has run.
type GuardedAction = {
  readonly name: string;
  readonly step: JsonRecord;
  readonly element: Partial<ResolvedElement>;
  readonly effect: { readonly read: (session: Session) => Promise<string>; readonly untouched: string; readonly done: string };
};

const shown = (id: string) => (session: Session): Promise<string> => shownText(capability, session, id);
const noteValue = async (session: Session): Promise<string> => expectOneElement(await session.probe(capability.locator(label('Note')), null)).value ?? '';

const CLICK_FILL_AND_PRESS: readonly GuardedAction[] = [
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

const HOVER_SELECT_AND_UPLOAD: readonly GuardedAction[] = [
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
  { targetId: BrowserTarget.Chrome, actions: [...CLICK_FILL_AND_PRESS, ...HOVER_SELECT_AND_UPLOAD] },
] as const;

for (const { targetId, actions } of DRIVERS) {
  describe(`the runtime guard on ${targetId}`, () => {
    for (const action of actions) {
      test(`a denied ${action.name} ends with policy-denied and sends no input event`, async () => {
        const { guard, calls } = spyGuard(DENY);
        await withGuardPage(targetId, async (session) => {
          const acted = await session.act(capability.actionStep(action.step), guard);
          assert.equal(acted.ok ? 'passed' : acted.error.code, 'policy-denied');
          assert.equal(await shownText(capability, session, 'input-events'), '0', 'no input event reached the page');
          assert.equal(await action.effect.read(session), action.effect.untouched);
        });
        assert.equal(calls.length, 1, 'the guard was asked once');
      });

      test(`the guard is told the resolved element of the ${action.name} step`, async () => {
        const { guard, calls } = spyGuard(DENY);
        await withGuardPage(targetId, async (session) => { await session.act(capability.actionStep(action.step), guard); });
        const asked = calls[0];
        assert.ok(asked !== undefined, 'the guard was asked');
        for (const [field, value] of Object.entries(action.element)) {assert.equal(asked.element[field as keyof ResolvedElement], value, field);}
        assert.ok(asked.element.box !== null && asked.element.box.width > 0 && asked.element.box.height > 0, 'the element was resolved on the page');
        assert.equal(asked.element.formSubmitName, null, 'the control is outside any form');
        assert.equal(asked.dialogText, null);
      });

      test(`counter-example: an allowed ${action.name} reaches the page`, async () => {
        const { guard, calls } = spyGuard(ALLOW);
        await withGuardPage(targetId, async (session) => {
          const acted = await session.act(capability.actionStep(action.step), guard);
          assert.ok(acted.ok, acted.ok ? '' : `${acted.error.code}: ${acted.error.detail}`);
          assert.equal(await action.effect.read(session), action.effect.done);
        });
        assert.equal(calls.length, 1);
      });
    }

    test('an element that is never found is not passed to the guard', async () => {
      const { guard, calls } = spyGuard(ALLOW);
      await withGuardPage(targetId, async (session) => {
        const acted = await session.act(capability.actionStep(click(role('button', 'Does not exist'))), guard);
        assert.equal(acted.ok ? 'passed' : acted.error.code, 'not-found');
      });
      assert.equal(calls.length, 0);
    });
  });
}

describe(`the runtime guard on dialogs: ${BrowserTarget.Chrome}`, () => {
  test('a denied dialog answer ends with policy-denied; the guard gets the dialog text and an empty element', async () => {
    const { guard, calls } = spyGuard({ kind: PolicyVerdictKind.Deny, rule: PolicyRuleId.IrreversibleDialog, stepIndex: 2 });
    await withGuardPage(BrowserTarget.Chrome, async (session) => {
      assert.ok((await session.act(capability.actionStep(click(role('button', 'Ask a question'))), allowEveryAction)).ok, 'the click opens the dialog');
      const answered = await session.act(capability.actionStep({ type: 'dialog', action: 'accept', expectText: 'Keep the draft?' }), guard);
      assert.equal(answered.ok ? 'passed' : answered.error.code, 'policy-denied');
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { element: { role: null, name: null, box: null, formSubmitName: null, linkUrl: null }, dialogText: 'Keep the draft?' });
  });

  test('counter-example: an allowed dialog answer accepts the dialog', async () => {
    const { guard, calls } = spyGuard(ALLOW);
    await withGuardPage(BrowserTarget.Chrome, async (session) => {
      assert.ok((await session.act(capability.actionStep(click(role('button', 'Ask a question'))), allowEveryAction)).ok);
      const answered = await session.act(capability.actionStep({ type: 'dialog', action: 'accept', expectText: 'Keep the draft?' }), guard);
      assert.ok(answered.ok, answered.ok ? '' : `${answered.error.code}: ${answered.error.detail}`);
      assert.equal(await shownText(capability, session, 'dialog-status'), 'Kept');
    });
    assert.equal(calls[0]?.dialogText, 'Keep the draft?');
  });
});

describe(`the real policy gate, through a run: ${BrowserTarget.Chrome}`, () => {
  // Reads the page's input-event count just before the run closes the session.
  const runReadingInputEvents = async (steps: readonly unknown[]) => {
    const watched = watchedDriver(capabilityCdpDriver(BROWSERS.chrome), (session) => shownText(capability, session, 'input-events'));
    const drivers = new Map([...capabilityDrivers(), ['cdp', watched.driver]]);
    const ran = await capability.run(capability.plan(capabilityPlan(BrowserTarget.Chrome, steps)), BrowserTarget.Chrome, { drivers });
    return { ...ran, inputEvents: watched.sessions[0]?.readBeforeClose ?? null };
  };

  test('a click on a control named "Delete account" ends the run Denied with nothing sent', async () => {
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

  test('counter-example: the same run clicking "Save draft" passes and sends the click', async () => {
    const { result, inputEvents } = await runReadingInputEvents([
      navigate('/guard.html'),
      click(role('button', 'Save draft')),
      textEquals(testId('save-clicks'), '1', 'guard.saved'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.notEqual(inputEvents, '0');
  });

  test('accepting a dialog whose text is irreversible ends the run Denied', async () => {
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
