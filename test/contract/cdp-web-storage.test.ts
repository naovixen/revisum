// Web storage on the own CDP driver. setStorage writes a declared entry into the current page's
// own storage, through CDP's DOMStorage domain and no page script: a later expectStorage sees
// the value, the page itself reads it, and removeStorage makes it absent. A write while the page
// is on another origin than the entry's fails with storage-origin-mismatch and writes nothing,
// on either origin. The counter-examples show the checks can fail, and that the same write
// succeeds once the page is on the entry's origin.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import type { Session } from '@revisum/engine';
import {
  CDP_TARGET, expectStorage, navigate, networkHarness, outcomes, removeStorage, setStorage, testId, textEquals,
  type NetworkHarness, type NetworkRun,
} from './network-stubs-support.ts';

let harness: NetworkHarness;
before(async () => { harness = await networkHarness(); });
after(async () => { await harness.close(); });

const assertPassed = (ran: NetworkRun): void => assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
const openStorage = () => navigate('/storage.html');
const dockedShown = (value: string, criterionId: string) => textEquals(testId('stored-docked'), value, criterionId);
const greetingShown = (value: string, criterionId: string) => textEquals(testId('stored-greeting'), value, criterionId);

describe('writing, checking and removing a storage entry', () => {
  test('after setStorage, expectStorage sees the value and the page reads it; after removeStorage it is absent', { criterion: 'AC-SPEC-33-10' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openStorage(),
      dockedShown('(none)', 'storage.nothing-yet'),
      expectStorage('menuDocked', { kind: 'absent' }, 'storage.absent-at-first'),
      setStorage('menuDocked', { docked: true }),
      expectStorage('menuDocked', { kind: 'present' }, 'storage.present'),
      // A boolean result is stored as JSON.
      expectStorage('menuDocked', { kind: 'equals', value: 'true' }, 'storage.equals'),
      dockedShown('true', 'storage.page-reads-it'),
      removeStorage('menuDocked'),
      expectStorage('menuDocked', { kind: 'absent' }, 'storage.absent-after-remove'),
      dockedShown('(none)', 'storage.page-reads-none'),
    ]);
    assertPassed(ran);
  });

  test('a string value is written to session storage as it is', { criterion: 'AC-SPEC-33-10' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openStorage(),
      setStorage('visitGreeting'),
      expectStorage('visitGreeting', { kind: 'equals', value: 'Welcome back' }, 'storage.session-equals'),
      greetingShown('Welcome back', 'storage.session-page-reads-it'),
      // Session storage is not local storage: the local key of the same page is still unset.
      dockedShown('(none)', 'storage.local-untouched'),
    ]);
    assertPassed(ran);
  });

  test('a false argument is stored as false, and a later write replaces the value', { criterion: 'AC-SPEC-33-10' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      openStorage(),
      setStorage('menuDocked', { docked: false }),
      expectStorage('menuDocked', { kind: 'equals', value: 'false' }, 'storage.false'),
      setStorage('menuDocked', { docked: true }),
      expectStorage('menuDocked', { kind: 'equals', value: 'true' }, 'storage.replaced'),
      dockedShown('true', 'storage.page-reads-replacement'),
    ]);
    assertPassed(ran);
  });

  // Counter-examples: the storage checks can fail.
  const FAILING: readonly { readonly name: string; readonly steps: () => unknown[] }[] = [
    { name: 'present before any write', steps: () => [expectStorage('menuDocked', { kind: 'present' }, 'storage.not-yet-present')] },
    {
      name: 'equals another value', steps: () => [
        setStorage('menuDocked', { docked: true }), expectStorage('menuDocked', { kind: 'equals', value: 'false' }, 'storage.other-value'),
      ],
    },
    {
      name: 'absent after a write', steps: () => [
        setStorage('menuDocked', { docked: true }), expectStorage('menuDocked', { kind: 'absent' }, 'storage.still-there'),
      ],
    },
    {
      name: 'present after a remove', steps: () => [
        setStorage('menuDocked', { docked: true }), removeStorage('menuDocked'), expectStorage('menuDocked', { kind: 'present' }, 'storage.gone'),
      ],
    },
  ];
  for (const failing of FAILING) {
    test(`counter-example: expectStorage ${failing.name} fails`, { criterion: 'AC-SPEC-33-10' }, async () => {
      const ran = await harness.runSteps(CDP_TARGET, [openStorage(), ...failing.steps()]);
      const all = outcomes(ran.result);
      assert.deepEqual(all.at(-1), [all.length - 1, 'failed', 'assertion-failed'], JSON.stringify(ran.result.steps));
      assert.deepEqual(all.slice(0, -1).filter(([, outcome]) => outcome !== 'passed'), []);
    });
  }
});

describe('a write while the page is on another origin', () => {
  test('setStorage for an entry on another origin fails with storage-origin-mismatch and writes nothing on either origin', { criterion: 'AC-SPEC-33-10' }, async () => {
    const seen: { otherOrigin: string | null } = { otherOrigin: null };
    const readOtherOrigin = async (session: Session): Promise<void> => {
      const opened = await session.navigate(harness.otherUrl('/storage.html'));
      assert.ok(opened.ok, JSON.stringify(opened));
      seen.otherOrigin = await harness.shownOn(session, 'stored-docked');
    };
    const ran = await harness.runSteps(CDP_TARGET, [
      openStorage(),
      setStorage('otherMenuDocked', { docked: true }),
      dockedShown('(none)', 'storage.never-reached'),
    ], { read: ['stored-docked'], beforeClose: readOtherOrigin });
    assert.equal(ran.result.state, 'Failed');
    assert.deepEqual(outcomes(ran.result), [[0, 'passed', undefined], [1, 'failed', 'storage-origin-mismatch'], [2, 'skipped', undefined]]);
    assert.equal(ran.atClose?.shown['stored-docked'], '(none)', 'nothing was written to the page\'s own origin');
    assert.equal(seen.otherOrigin, '(none)', 'nothing was written to the entry\'s origin');
  });

  test('counter-example: the same write with the page on the entry\'s origin succeeds, and that origin\'s page reads it', { criterion: 'AC-SPEC-33-10' }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate(harness.otherUrl('/storage.html')),
      setStorage('otherMenuDocked', { docked: true }),
      expectStorage('otherMenuDocked', { kind: 'equals', value: 'true' }, 'storage.other-origin-equals'),
      dockedShown('true', 'storage.other-origin-page-reads-it'),
      // The same key on the first origin, in the same browser, was not written.
      openStorage(),
      dockedShown('(none)', 'storage.first-origin-untouched'),
    ]);
    assertPassed(ran);
  });
});
