// Nothing a page script or an attribute read hands back reaches what a run keeps, beyond what the
// plan declares. Two kinds of run, each ending with one failed check so text is kept:
//   - an attribute remembered (fixtures/unsafe-features-app/orders.html): the order row carries a
//     canary order id; the plan remembers it from the attribute, types it into a field, checks it
//     there and on the row, captures the page, and ends with a failed check of the field. The
//     value appears only as its name and sha256, and the kept observation is redacted;
//   - a page script returning a planted secret and a planted session cookie (leaks.html): the page
//     is served with a session cookie scripts can read, and the plan types a secret into the token
//     field. The declared script leakyResult returns both, beside its two declared fields, status
//     and itemCount. The plan remembers status, checks itemCount, captures the page, and ends with a
//     failed check of status.
// The leak scan runs over every result, event log, audit log and image beside a planted copy of
// each value: it must find each value only where it was planted. The control runs check an
// element showing each canary against a text it never equals, so the observation does reach the
// result, and the scan finds it there.
// Not covered here: the visual report, which a run cannot produce until the result model joins it
// (SPEC-11, SPEC-12), and text drawn as pixels, which no text scan can read.
// See docs/specs/SPEC-36-unsafe-plan-features.md and docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { leakScanner, sha256 } from '@revisum/engine';
import {
  BOTH_TARGETS, CDP_TARGET, PAGE_SECRET, capture, check, evaluate, expectScript, fill, label, navigate, outcomes, reference, rememberAttribute,
  secretValue, testId, textEquals, unsafePageHarness, valueEquals, type JsonRecord, type UnsafePageHarness, type UnsafePageRun,
} from '../contract/unsafe-page-support.ts';
import { echoesIn, fakeEnvironmentStore, fakeSecretValue, resolvedSecret } from '../unit/engine/secret-examples.ts';

const TIMEOUT = 300_000;

let harness: UnsafePageHarness;
let folder: string;
let secretValueText: string;
before(async () => {
  harness = await unsafePageHarness();
  folder = mkdtempSync(join(tmpdir(), 'unsafe-page-leak-scan-'));
  secretValueText = fakeSecretValue();
});
after(async () => {
  await harness.close();
  rmSync(folder, { recursive: true, force: true });
});

const resultText = (ran: UnsafePageRun): string => JSON.stringify(ran.result, null, 2);
const eventLines = (ran: UnsafePageRun): string => ran.events.read().map((event) => JSON.stringify(event)).join('\n');
const auditLines = (ran: UnsafePageRun): string => ran.audit.recorded.map((recorded) => JSON.stringify(recorded)).join('\n');

// Writes the run's result, event log, audit events and images to the scan folder and returns their paths.
function writeOutputs(name: string, ran: UnsafePageRun): string[] {
  const paths = [join(folder, `${name}.result.json`), join(folder, `${name}.events.jsonl`), join(folder, `${name}.audit.jsonl`)];
  writeFileSync(paths[0] ?? '', resultText(ran));
  writeFileSync(paths[1] ?? '', eventLines(ran));
  writeFileSync(paths[2] ?? '', auditLines(ran));
  for (const artifact of ran.store.references()) {
    const bytes = ran.store.get(artifact.name);
    if (bytes === undefined) continue;
    const path = join(folder, `${name}.artifact-${paths.length}.bin`);
    writeFileSync(path, bytes);
    paths.push(path);
  }
  return paths;
}

// Scans `outputs` beside a file holding a planted copy of each value, and checks each value is
// found in the planted file and nowhere else.
function assertFoundOnlyWherePlanted(name: string, outputs: readonly string[], planted: readonly (readonly [string, string])[]): void {
  const plantedPath = join(folder, `${name}.planted.json`);
  writeFileSync(plantedPath, JSON.stringify({ observed: planted.map(([, value]) => `planted ${value}`) }));
  const scanned = planted.map(([labelText, value]) => resolvedSecret(labelText, value));
  const leaks = leakScanner().scan([...outputs, plantedPath], scanned);
  for (const secret of scanned) {
    assert.ok(leaks.some((leak) => leak.secret === secret.name && leak.file === plantedPath), `the scan found the planted ${secret.name}`);
  }
  assert.deepEqual(leaks.filter((leak) => leak.file !== plantedPath).map((leak) => `${leak.secret} in ${leak.file}`), [], 'each value is found only where it was planted');
}

function assertNoEchoes(name: string, ran: UnsafePageRun, planted: readonly (readonly [string, string])[]): void {
  for (const [labelText, value] of planted) {
    assert.deepEqual(echoesIn(resultText(ran), value), [], `${name}: forms of ${labelText} in the result`);
    assert.deepEqual(echoesIn(eventLines(ran), value), [], `${name}: forms of ${labelText} in the event log`);
    assert.deepEqual(echoesIn(auditLines(ran), value), [], `${name}: forms of ${labelText} in the audit events`);
  }
}

// Every step before the last passed, and the last failed as planned.
function assertOnlyLastFailed(name: string, ran: UnsafePageRun): void {
  const all = outcomes(ran.result);
  const last = all.length - 1;
  assert.deepEqual(all.slice(0, last).filter(([, outcome]) => outcome !== 'passed'), [], `${name}: ${JSON.stringify(ran.result.steps)}`);
  assert.equal(all[last]?.[1], 'failed', `${name}: the last check failed as planned`);
  assert.ok(ran.store.references().length > 0, `${name}: the run kept its capture`);
}

// ---- An attribute remembered ---------------------------------------------------------------------

const ORDER_VALUE = 'orderId';
const orderRow = testId('order-row');
const orderField = label('Order reference');

// Remembers the order id from its attribute, uses it and checks it, then ends with `ending`.
const orderSteps = (ending: JsonRecord): unknown[] => [
  navigate('/orders.html'),
  rememberAttribute(ORDER_VALUE, orderRow, 'data-order-id'),
  fill(orderField, reference(ORDER_VALUE)),
  valueEquals(orderField, reference(ORDER_VALUE), 'orders.reference-typed'),
  check(orderRow, { kind: 'attributeEquals', name: 'data-order-id', value: reference(ORDER_VALUE) }, 'orders.row-matches'),
  capture('order-typed'),
  ending,
];

const ORDER_ENDINGS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
  { name: 'field-check-fails', step: valueEquals(orderField, 'deliberately wrong', 'orders.reference-wrong') },
  { name: 'attribute-check-fails', step: check(orderRow, { kind: 'attributeEquals', name: 'data-order-id', value: 'deliberately wrong' }, 'orders.row-wrong') },
];

// A remember from an attribute needs rememberedValues too, which only the own CDP driver declares.
describe(`an attribute remembered: ${CDP_TARGET}`, () => {
  test('the leak scan finds the remembered order id in no output of runs that type it, check it and fail a check', { criterion: 'AC-SPEC-36-07', timeout: TIMEOUT }, async () => {
    const planted = [['ORDER_ID_CANARY', harness.canaries.orderId]] as const;
    const outputs: string[] = [];
    for (const { name, step } of ORDER_ENDINGS) {
      const ran = await harness.runSteps(CDP_TARGET, orderSteps(step));
      assertOnlyLastFailed(name, ran);
      assertNoEchoes(name, ran, planted);
      outputs.push(...writeOutputs(`order-${name}`, ran));
    }
    assertFoundOnlyWherePlanted('order', outputs, planted);
  });

  test('the remembered attribute appears in the result and event log only as its name and sha256', { criterion: 'AC-SPEC-36-07', timeout: TIMEOUT }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, orderSteps(check(orderRow, { kind: 'visible' }, 'orders.row-shown')));
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    const digest = sha256(harness.canaries.orderId);
    assert.deepEqual(ran.result.steps[1]?.remembered, { valueName: ORDER_VALUE, sha256: digest });
    assert.ok(eventLines(ran).includes(digest), 'the event log holds the remembered value\'s sha256');
  });

  // Control: the canary, typed as plain plan text (not a remembered value) and observed by a failed
  // check of the field, does reach the result, and the scan finds it there.
  test('control: a failed check of the field holding the order id typed as plain text keeps it, and the scan finds it', { criterion: 'AC-SPEC-36-07', timeout: TIMEOUT }, async () => {
    const ran = await harness.runSteps(CDP_TARGET, [
      navigate('/orders.html'),
      fill(orderField, harness.canaries.orderId),
      valueEquals(orderField, 'deliberately wrong', 'orders.reference-wrong'),
    ]);
    const typed = ran.result.steps[2];
    assert.equal(typed?.outcome, 'failed');
    assert.ok(typed?.observed?.includes(harness.canaries.orderId), `the observation should hold the canary: ${typed?.observed ?? '(none)'}`);
    const leaks = leakScanner().scan(writeOutputs('order-control', ran), [resolvedSecret('ORDER_ID_CANARY', harness.canaries.orderId)]);
    assert.ok(leaks.some((leak) => leak.file.endsWith('order-control.result.json')), 'the scan found the canary in the control result');
  });
});

// ---- A page script returning a planted secret and session cookie ------------------------------------

const STATUS_VALUE = 'statusText';

// Types the secret, runs the leaky script for a remembered field and for a check, captures the
// page, then ends with `ending`.
const scriptSteps = (ending: JsonRecord): unknown[] => [
  navigate('/leaks.html'),
  fill(label('Access token'), secretValue(PAGE_SECRET)),
  evaluate('leakyResult', {}, { [STATUS_VALUE]: 'status' }),
  expectScript('leakyResult', {}, 'itemCount', { kind: 'numberEquals', value: 3 }, 'leaks.item-count'),
  capture('after-script'),
  ending,
];

const SCRIPT_ENDINGS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
  { name: 'status-check-fails', step: expectScript('leakyResult', {}, 'status', { kind: 'equals', value: 'deliberately wrong' }, 'leaks.status-wrong') },
  { name: 'count-check-fails', step: expectScript('leakyResult', {}, 'itemCount', { kind: 'numberEquals', value: 4 }, 'leaks.item-count-wrong') },
];

for (const targetId of BOTH_TARGETS) {
  describe(`a page script returning a secret and a session cookie: ${targetId}`, () => {
    const planted = (): readonly (readonly [string, string])[] => [
      ['PAGE_SECRET_VALUE', secretValueText],
      ['SESSION_COOKIE_CANARY', harness.canaries.sessionCookie],
    ];

    test('the leak scan finds neither the secret nor the session cookie in any output; only the declared fields were read', { criterion: 'AC-SPEC-36-11', timeout: TIMEOUT }, async () => {
      const secrets = fakeEnvironmentStore({ [PAGE_SECRET]: secretValueText });
      const outputs: string[] = [];
      for (const { name, step } of SCRIPT_ENDINGS) {
        const ran = await harness.runSteps(targetId, scriptSteps(step), { secrets });
        assertOnlyLastFailed(name, ran);
        assertNoEchoes(name, ran, planted());
        outputs.push(...writeOutputs(`script-${targetId}-${name}`, ran));
      }
      assertFoundOnlyWherePlanted(`script-${targetId}`, outputs, planted());
    });

    test('the remembered field is the declared one: its record is the sha256 of "ok", the status the script returned', { criterion: 'AC-SPEC-36-11', timeout: TIMEOUT }, async () => {
      const ran = await harness.runSteps(targetId, scriptSteps(check(testId('input-events'), { kind: 'visible' }, 'leaks.page-shown')), {
        secrets: fakeEnvironmentStore({ [PAGE_SECRET]: secretValueText }),
      });
      assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
      assert.deepEqual(ran.result.steps[2]?.remembered, { valueName: STATUS_VALUE, sha256: sha256('ok') });
    });

    // Control: the cookie, observed by a failed check of the element the page shows it in, does
    // reach the result, and the scan finds it there, so the scan above could have found it.
    test('control: a failed check of the element showing the session cookie keeps it in the result, and the scan finds it', { criterion: 'AC-SPEC-36-11', timeout: TIMEOUT }, async () => {
      const ran = await harness.runSteps(targetId, [navigate('/leaks.html'), textEquals(testId('session-shown'), 'deliberately wrong', 'leaks.session-shown')]);
      const shown = ran.result.steps[1];
      assert.equal(shown?.outcome, 'failed');
      assert.ok(shown?.observed?.includes(harness.canaries.sessionCookie), `the observation should hold the cookie: ${shown?.observed ?? '(none)'}`);
      const leaks = leakScanner().scan(writeOutputs(`script-${targetId}-control`, ran), [resolvedSecret('SESSION_COOKIE_CANARY', harness.canaries.sessionCookie)]);
      assert.ok(leaks.some((leak) => leak.file.endsWith(`script-${targetId}-control.result.json`)), 'the scan found the cookie in the control result');
    });
  });
}
