// Clipboard checks in a real browser, on the own CDP driver. The fixture page
// (fixtures/clock-and-clipboard-app/clipboard.html) has copy buttons for one line, three lines
// with CRLF line endings, a code that lands about 300 ms after its click, 25,000 characters and an
// invite link built from a field.
//   - textEquals, textContains and textExcludes pass and fail as expected; multi-line textEquals
//     compares against the lines joined by "\n"; before any copy every check fails, textExcludes
//     included, and a failed check reports only "empty" or "differs".
//   - A copied invite link built from a uniqueEmail value contains that value; a remembered link
//     can be typed into a field; a clipboard remember fails on empty, multi-line and over-limit text.
//   - The page's own script cannot read the clipboard, before or after the driver's own read. The
//     counter-example grants a browser started by the CDP driver's launcher clipboard access, and the
//     same button then reads.
// The browsers are headless and the clipboard is the browser's own; the person's clipboard is
// still saved and put back around this file, in case a copy reaches it.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ATTACH_TO_TARGET, CREATE_TARGET, ENABLE_PAGE, NAVIGATE, SET_FOCUS_EMULATION, launchChromium } from '@revisum/driver-cdp';
import { EVALUATE_WITH_A_GESTURE, GRANT_PERMISSIONS, PAGE_LOADED } from '#test-support/browser/TestCommand.ts';
import { BROWSERS } from '#test-support/browsers.ts';
import { onTarget } from '#test-support/TestTier.ts';
import { outcomes, stepMilliseconds, type BrowserRun } from '#test-support/browser/BrowserHarness.ts';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { click, fill, label, navigate, reference, role, testId, textEquals, valueEquals, type JsonRecord } from '#test-support/browser/RawPlan.ts';
import { ADDRESS_LINES, INVITE_CODE, LATE_CODE, clockHarness, expectClipboard, rememberClipboard, type ClockHarness } from './clock-and-clipboard-support.ts';
import { guardHostClipboard } from './host-clipboard.ts';

const hostClipboard = await guardHostClipboard();
const copying = { skip: hostClipboard.skipReason ?? false };

let harness: ClockHarness;
before(async () => { harness = await clockHarness(); });
after(async () => {
  await harness.close();
  await hostClipboard.restore();
});

const assertPassed = (ran: BrowserRun): void => assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
const openClipboardPage = navigate('/clipboard.html');
const copyInviteCode = click(role('button', 'Copy invite code'));
const copyAddress = click(role('button', 'Copy address'));
const copyLateCode = click(role('button', 'Copy late code'));
const copyLongText = click(role('button', 'Copy long text'));
const copyInviteLink = click(role('button', 'Copy invite link'));
const readInPage = click(role('button', 'Read the clipboard'));
const pageRead = (value: string, criterionId: string) => textEquals(testId('page-read'), value, criterionId);

// Runs the steps and expects every step to pass but the last, which fails with `code`. Gives the
// failed step's result.
async function lastStepFails(steps: readonly unknown[], code: string, targetId: string = BrowserTarget.Chrome) {
  const ran = await harness.runSteps(targetId, steps);
  const all = outcomes(ran.result);
  const last = all.length - 1;
  assert.deepEqual(all.slice(0, last).filter(([, outcome]) => outcome !== 'passed'), [], JSON.stringify(ran.result.steps));
  assert.deepEqual(all[last], [last, 'failed', code], JSON.stringify(ran.result.steps));
  return ran.result.steps[last];
}

// ---- Checking the clipboard's text --------------------------------------------------------------

type Check = { readonly name: string; readonly step: JsonRecord };

const PASSING_ONE_LINE: readonly Check[] = [
  { name: 'textEquals the copied line', step: expectClipboard('textEquals', INVITE_CODE, 'clipboard.equals') },
  { name: 'textContains part of it', step: expectClipboard('textContains', 'HX-4471', 'clipboard.contains') },
  { name: 'textExcludes text it does not hold', step: expectClipboard('textExcludes', 'password', 'clipboard.excludes') },
];
const FAILING_ONE_LINE: readonly Check[] = [
  { name: 'textEquals another line', step: expectClipboard('textEquals', 'Invite code: HX-4472', 'clipboard.equals-other') },
  { name: 'textEquals only part of it', step: expectClipboard('textEquals', 'HX-4471', 'clipboard.equals-part') },
  { name: 'textContains text it does not hold', step: expectClipboard('textContains', 'HX-9999', 'clipboard.contains-other') },
  { name: 'textExcludes text it holds', step: expectClipboard('textExcludes', 'HX-4471', 'clipboard.excludes-held') },
];

for (const targetId of Object.values(BrowserTarget)) {
  describe(`one copied line on ${targetId}`, () => {
    for (const { name, step } of PASSING_ONE_LINE) {
      test(`after a copy, ${name} passes`, { ...copying, ...onTarget(targetId) }, async () => {
        assertPassed(await harness.runSteps(targetId, [openClipboardPage, copyInviteCode, step]));
      });
    }
    for (const { name, step } of FAILING_ONE_LINE) {
      test(`after a copy, ${name} fails and reports only that the text differs`, { ...copying, ...onTarget(targetId) }, async () => {
        const failed = await lastStepFails([openClipboardPage, copyInviteCode, step], 'assertion-failed', targetId);
        assert.equal(failed?.observed ?? 'differs', 'differs', JSON.stringify(failed));
      });
    }
  });
}

describe('before any copy', () => {
  const CHECKS: readonly Check[] = [
    { name: 'textEquals', step: expectClipboard('textEquals', INVITE_CODE, 'clipboard.equals-before-copy') },
    { name: 'textContains', step: expectClipboard('textContains', 'HX-4471', 'clipboard.contains-before-copy') },
    { name: 'textExcludes', step: expectClipboard('textExcludes', 'password', 'clipboard.excludes-before-copy') },
    { name: 'multi-line textEquals', step: expectClipboard('textEquals', { lines: [...ADDRESS_LINES] }, 'clipboard.lines-before-copy') },
  ];
  for (const { name, step } of CHECKS) {
    test(`${name} fails on the empty clipboard and reports only that it is empty`, { ...copying }, async () => {
      const failed = await lastStepFails([openClipboardPage, step], 'assertion-failed');
      assert.equal(failed?.observed ?? 'empty', 'empty', JSON.stringify(failed));
    });
  }
});

describe('multi-line text with CRLF line endings', () => {
  test('textEquals with the three lines passes: the clipboard is compared with the lines joined by "\\n"', { ...copying }, async () => {
    assertPassed(await harness.runSteps(BrowserTarget.Chrome, [openClipboardPage, copyAddress, expectClipboard('textEquals', { lines: [...ADDRESS_LINES] }, 'clipboard.lines-equal')]));
  });

  test('textContains one of the lines passes', { ...copying }, async () => {
    assertPassed(await harness.runSteps(BrowserTarget.Chrome, [openClipboardPage, copyAddress, expectClipboard('textContains', '12 St James Square', 'clipboard.line-contained')]));
  });

  const WRONG_LINES: readonly { readonly name: string; readonly lines: readonly string[] }[] = [
    { name: 'a missing line', lines: [ADDRESS_LINES[0], ADDRESS_LINES[2]] },
    { name: 'the lines in another order', lines: [ADDRESS_LINES[2], ADDRESS_LINES[1], ADDRESS_LINES[0]] },
    { name: 'an extra line', lines: [...ADDRESS_LINES, 'United Kingdom'] },
  ];
  for (const { name, lines } of WRONG_LINES) {
    test(`counter-example: textEquals with ${name} fails`, { ...copying }, async () => {
      await lastStepFails([openClipboardPage, copyAddress, expectClipboard('textEquals', { lines }, 'clipboard.lines-differ')], 'assertion-failed');
    });
  }
});

describe('a copy that lands about 300 ms after its click', () => {
  test('textEquals waits for the late copy and passes', { ...copying }, async () => {
    const ran = await harness.runSteps(BrowserTarget.Chrome, [openClipboardPage, copyLateCode, expectClipboard('textEquals', LATE_CODE, 'clipboard.late-copy')]);
    assertPassed(ran);
    assert.ok(stepMilliseconds(ran.result, 2) >= 200, `the check waited for the copy: ${stepMilliseconds(ran.result, 2)} ms`);
  });

  test('counter-example: a check for text the late copy never holds still fails after waiting', { ...copying }, async () => {
    await lastStepFails([openClipboardPage, copyLateCode, expectClipboard('textEquals', 'Late code: QZ-0000', 'clipboard.late-copy-other')], 'assertion-failed');
  });
});

// ---- Run values and the clipboard ---------------------------------------------------------------

const INVITE_VALUES: JsonRecord = {
  invitee: { kind: 'uniqueEmail', localPrefix: 'invitee' },
  otherInvitee: { kind: 'uniqueEmail', localPrefix: 'stranger' },
};

describe('a copied invite link and run values', () => {
  test('a link built from a uniqueEmail value contains that value', { ...copying }, async () => {
    const ran = await harness.runSteps(BrowserTarget.Chrome, [
      openClipboardPage,
      fill(label('Email address'), reference('invitee')),
      copyInviteLink,
      expectClipboard('textContains', reference('invitee'), 'invite.link-holds-email'),
      expectClipboard('textContains', '/join?email=', 'invite.link-shape'),
    ], { fields: { values: INVITE_VALUES } });
    assertPassed(ran);
  });

  test('counter-example: the link does not contain another uniqueEmail value', { ...copying }, async () => {
    const ran = await harness.runSteps(BrowserTarget.Chrome, [
      openClipboardPage,
      fill(label('Email address'), reference('invitee')),
      copyInviteLink,
      expectClipboard('textContains', reference('otherInvitee'), 'invite.link-holds-other-email'),
    ], { fields: { values: INVITE_VALUES } });
    assert.deepEqual(outcomes(ran.result).at(-1), [3, 'failed', 'assertion-failed'], JSON.stringify(ran.result.steps));
  });

  test('a remembered link typed into a field is the copied link', { ...copying }, async () => {
    const link = harness.url('/join?email=ada@example.test');
    const ran = await harness.runSteps(BrowserTarget.Chrome, [
      openClipboardPage,
      fill(label('Email address'), 'ada@example.test'),
      copyInviteLink,
      expectClipboard('textEquals', link, 'invite.link-copied'),
      rememberClipboard('inviteLink'),
      fill(label('Pasted link'), reference('inviteLink')),
      valueEquals(label('Pasted link'), link, 'invite.link-typed'),
      valueEquals(label('Pasted link'), reference('inviteLink'), 'invite.link-matches-value'),
    ]);
    assertPassed(ran);
    assert.equal(ran.result.steps[4]?.remembered?.valueName, 'inviteLink', 'the remember step records the value by name');
  });

  const FAILING_REMEMBERS: readonly { readonly name: string; readonly copy: readonly JsonRecord[]; readonly code: string }[] = [
    { name: 'the empty clipboard, before any copy', copy: [], code: 'value-empty' },
    { name: 'multi-line text', copy: [copyAddress, expectClipboard('textContains', 'London', 'remember.address-copied')], code: 'value-unsafe' },
    { name: 'text longer than the clipboard limit', copy: [copyLongText, textEquals(testId('copy-state'), 'Copied 25000 characters', 'remember.long-copied')], code: 'value-too-long' },
  ];
  for (const { name, copy, code } of FAILING_REMEMBERS) {
    test(`a clipboard remember of ${name} fails with ${code}, and the fill that uses it is skipped`, { ...copying }, async () => {
      const ran = await harness.runSteps(BrowserTarget.Chrome, [
        openClipboardPage, ...copy, rememberClipboard('copiedText'), fill(label('Pasted link'), reference('copiedText')),
        valueEquals(label('Pasted link'), reference('copiedText'), 'remember.typed'),
      ], { read: ['input-events'] });
      const rememberIndex = 1 + copy.length;
      assert.deepEqual(outcomes(ran.result).slice(rememberIndex), [
        [rememberIndex, 'failed', code], [rememberIndex + 1, 'skipped', undefined], [rememberIndex + 2, 'skipped', undefined],
      ], JSON.stringify(ran.result.steps));
      assert.equal(ran.result.steps[rememberIndex]?.remembered, undefined, 'nothing was remembered');
    });
  }

  test('counter-example: a clipboard remember of one copied line passes', { ...copying }, async () => {
    assertPassed(await harness.runSteps(BrowserTarget.Chrome, [
      openClipboardPage, copyInviteCode, expectClipboard('textEquals', INVITE_CODE, 'remember.code-copied'), rememberClipboard('inviteCode'),
      fill(label('Pasted link'), reference('inviteCode')), valueEquals(label('Pasted link'), INVITE_CODE, 'remember.code-typed'),
    ]));
  });
});

// ---- The page's own reads ------------------------------------------------------------------------

describe('the page reading the clipboard itself', () => {
  for (const targetId of Object.values(BrowserTarget)) {
    test(`on ${targetId}, the page's reads before and after an expectClipboard step are both refused`, { ...copying, ...onTarget(targetId) }, async () => {
      const ran = await harness.runSteps(targetId, [
        openClipboardPage,
        copyInviteCode,
        textEquals(testId('copy-state'), `Copied ${INVITE_CODE.length} characters`, 'page-read.copied'),
        readInPage,
        pageRead('Refused, attempt 1', 'page-read.refused-before'),
        expectClipboard('textEquals', INVITE_CODE, 'page-read.driver-reads'),
        readInPage,
        pageRead('Refused, attempt 2', 'page-read.refused-after'),
      ]);
      assertPassed(ran);
    });
  }

  // The same page and button in a browser that grants the page clipboard access: the read is no
  // longer refused, so "Refused" above comes from the run's browser, not from the page. The page
  // reads without writing, and shows only a length, so nothing of the host's clipboard is kept.
  test('counter-example: with clipboard access granted, the same button reads the clipboard', { ...copying }, async () => {
    const launched = await launchChromium(BROWSERS.chrome, { profilePrefix: 'clipboard-grant-test-' });
    try {
      await launched.connection.ask(undefined, GRANT_PERMISSIONS, {
        origin: harness.origin, permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
      });
      const { targetId } = await launched.connection.ask(undefined, CREATE_TARGET, { url: 'about:blank' });
      const { sessionId } = await launched.connection.ask(undefined, ATTACH_TO_TARGET, { targetId, flatten: true });
      const page = launched.connection.session(sessionId);
      await page.ask(ENABLE_PAGE, {});
      await page.ask(SET_FOCUS_EMULATION, { enabled: true });
      // Wait for the real page: the blank first document also reads as complete, and has no button.
      const loaded = Promise.withResolvers<void>();
      const stopListening = page.listen(PAGE_LOADED, loaded.resolve, loaded.reject);
      const navigated = await page.ask(NAVIGATE, { url: harness.url('/clipboard.html') });
      assert.equal(navigated.errorText, undefined);
      await loaded.promise;
      stopListening();
      // Click as a person would (with a user gesture), then wait for the page to show what it read.
      const expression = `new Promise((resolve) => {
        document.getElementById('read-clipboard').click();
        const poll = () => {
          const shown = document.querySelector('[data-testid="page-read"]').textContent;
          if (shown === 'Not read') setTimeout(poll, 50); else resolve(shown);
        };
        poll();
      })`;
      const evaluated = await page.ask(EVALUATE_WITH_A_GESTURE, {
        expression, awaitPromise: true, returnByValue: true, userGesture: true,
      });
      assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails));
      assert.match(String(evaluated.result.value), /^Read \d+ characters, attempt 1$/);
    } finally {
      await launched.stop();
    }
  });
});
