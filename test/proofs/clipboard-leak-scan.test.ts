// Nothing the page copied reaches what a run keeps. Runs on the own CDP driver
// (fixtures/clock-and-clipboard-app/leaks.html):
//   - fill the token field with a planted secret and let the page copy it;
//   - let the page copy the canary name it shows, remember it from the clipboard, type
//     it into a field and check it;
// and each ends with one failed expectClipboard: once while the clipboard holds the canary, once
// while it holds the secret. The leak scan runs over every result, event log, audit log and image
// beside a planted copy of each value: it must find each value only where it was planted. The
// remembered value appears only as its name and sha256, and a failed check says only "differs".
// The control run checks the element showing the canary against a text it can never equal, so the
// observation does reach the result, and the scan finds it there.
// Not covered here: the visual report, which a run cannot produce until the result model joins it
// (SPEC-11, SPEC-12), and text drawn as pixels, which no text scan can read.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md and docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { leakScanner, sha256 } from '@revisum/engine';
import {
  CDP_TARGET, COPY_SECRET, capture, click, clockHarness, expectClipboard, fill, label, navigate, outcomes, reference, rememberClipboard, role,
  secretValue, testId, textEquals, valueEquals, type ClockHarness, type ClockRun, type JsonRecord,
} from '../contract/clock-and-clipboard-support.ts';
import { guardHostClipboard } from '../contract/host-clipboard.ts';
import { echoesIn, fakeEnvironmentStore, fakeSecretValue, resolvedSecret } from '../unit/engine/secret-examples.ts';

const TIMEOUT = 300_000;
const VALUE_NAME = 'contactName';

const hostClipboard = await guardHostClipboard();
const copying = { skip: hostClipboard.skipReason ?? false };

let harness: ClockHarness;
let folder: string;
let secretValueText: string;
before(async () => {
  harness = await clockHarness();
  folder = mkdtempSync(join(tmpdir(), 'clipboard-leak-scan-'));
  secretValueText = fakeSecretValue();
});
after(async () => {
  await harness.close();
  rmSync(folder, { recursive: true, force: true });
  await hostClipboard.restore();
});

const resultText = (ran: ClockRun): string => JSON.stringify(ran.result, null, 2);
const eventLines = (ran: ClockRun): string => ran.events.read().map((event) => JSON.stringify(event)).join('\n');
const auditLines = (ran: ClockRun): string => ran.audit.recorded.map((recorded) => JSON.stringify(recorded)).join('\n');

// Writes the run's result, event log, audit events and images to the scan folder and returns their paths.
function writeOutputs(name: string, ran: ClockRun): string[] {
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

const plantedValues = (): readonly (readonly [string, string])[] => [
  ['COPIED_SECRET', secretValueText],
  ['CONTACT_NAME_CANARY', harness.canaries.contactName],
];

const copyContact = click(role('button', 'Copy contact name'));
const copyToken = click(role('button', 'Copy access token'));

// Copies the secret and the canary, remembers and uses the canary, then ends with `ending`, whose
// last step is the one failed check.
const leakSteps = (ending: readonly JsonRecord[]): unknown[] => [
  navigate('/leaks.html'),
  fill(label('Access token'), secretValue(COPY_SECRET)),
  copyToken,
  // An empty clipboard fails every check, so this passes only once the secret has been copied.
  expectClipboard('textExcludes', 'never on the page', 'leaks.token-copied'),
  capture('token-copied'),
  copyContact,
  expectClipboard('textContains', ' Ellery', 'leaks.contact-copied'),
  rememberClipboard(VALUE_NAME),
  fill(label('Contact field'), reference(VALUE_NAME)),
  valueEquals(label('Contact field'), reference(VALUE_NAME), 'leaks.contact-typed'),
  capture('contact-typed'),
  ...ending,
];

const ENDINGS: readonly { readonly name: string; readonly steps: readonly JsonRecord[] }[] = [
  { name: 'canary-on-clipboard', steps: [expectClipboard('textEquals', 'deliberately wrong', 'leaks.contact-checked')] },
  { name: 'secret-on-clipboard', steps: [copyToken, expectClipboard('textContains', 'deliberately wrong', 'leaks.token-checked')] },
];

test('the leak scan finds no copied secret or canary personal data in what runs with clipboard checks keep', { criterion: 'AC-SPEC-34-15', timeout: TIMEOUT, ...copying }, async () => {
  const outputs: string[] = [];
  const secrets = fakeEnvironmentStore({ [COPY_SECRET]: secretValueText });
  for (const { name, steps } of ENDINGS) {
    const ran = await harness.runSteps(CDP_TARGET, leakSteps(steps), { secrets });
    // The probe is live: both values were copied, the canary was remembered and used, and every
    // check before the last passed.
    const all = outcomes(ran.result);
    const last = all.length - 1;
    assert.deepEqual(all.slice(0, last).filter(([, outcome]) => outcome !== 'passed'), [], `${name}: ${JSON.stringify(ran.result.steps)}`);
    assert.deepEqual(all[last], [last, 'failed', 'assertion-failed'], `${name}: the last check failed as planned`);
    assert.equal(ran.result.steps[last]?.observed ?? 'differs', 'differs', `${name}: the failed check says only that the text differs`);
    assert.ok(ran.store.references().length > 0, `${name}: the run kept its captures`);

    // Checked directly, without the engine's scanner.
    for (const [labelText, value] of plantedValues()) {
      assert.deepEqual(echoesIn(resultText(ran), value), [], `${name}: forms of ${labelText} in the result`);
      assert.deepEqual(echoesIn(eventLines(ran), value), [], `${name}: forms of ${labelText} in the event log`);
      assert.deepEqual(echoesIn(auditLines(ran), value), [], `${name}: forms of ${labelText} in the audit events`);
    }
    outputs.push(...writeOutputs(name, ran));
  }

  const plantedPath = join(folder, 'planted.values.json');
  writeFileSync(plantedPath, JSON.stringify({ observed: plantedValues().map(([, value]) => `planted ${value}`) }));
  const scanned = plantedValues().map(([labelText, value]) => resolvedSecret(labelText, value));
  const leaks = leakScanner().scan([...outputs, plantedPath], scanned);
  for (const secret of scanned) {
    assert.ok(leaks.some((leak) => leak.secret === secret.name && leak.file === plantedPath), `the scan found the planted ${secret.name}`);
  }
  assert.deepEqual(leaks.filter((leak) => leak.file !== plantedPath).map((leak) => `${leak.secret} in ${leak.file}`), [], 'each value is found only where it was planted');
});

test('a value remembered from the clipboard appears in the result and event log only as its name and sha256', { criterion: 'AC-SPEC-34-15', timeout: TIMEOUT, ...copying }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [
    navigate('/leaks.html'),
    copyContact,
    expectClipboard('textContains', ' Ellery', 'leaks.contact-copied'),
    rememberClipboard(VALUE_NAME),
    fill(label('Contact field'), reference(VALUE_NAME)),
    valueEquals(label('Contact field'), reference(VALUE_NAME), 'leaks.contact-typed'),
  ]);
  assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
  const digest = sha256(harness.canaries.contactName);
  assert.deepEqual(ran.result.steps[3]?.remembered, { valueName: VALUE_NAME, sha256: digest });
  assert.ok(eventLines(ran).includes(digest), 'the event log holds the remembered value\'s sha256');
  assert.deepEqual(echoesIn(resultText(ran), harness.canaries.contactName), []);
  assert.deepEqual(echoesIn(eventLines(ran), harness.canaries.contactName), []);
});

// Control: the canary, observed by a failed check of the element that shows it, does reach the
// result, and the scan finds it there.
test('control: a failed check of the element showing the canary keeps it in the result, and the scan finds it', { criterion: 'AC-SPEC-34-15', timeout: TIMEOUT }, async () => {
  const ran = await harness.runSteps(CDP_TARGET, [navigate('/leaks.html'), textEquals(testId('contact-name'), 'deliberately wrong', 'leaks.contact-shown')]);
  const check = ran.result.steps[1];
  assert.equal(check?.outcome, 'failed');
  assert.ok(check?.observed?.includes(harness.canaries.contactName), `the observation should hold the canary: ${check?.observed ?? '(none)'}`);
  const outputs = writeOutputs('control', ran);
  const leaks = leakScanner().scan(outputs, [resolvedSecret('CONTACT_NAME_CANARY', harness.canaries.contactName)]);
  assert.ok(leaks.some((leak) => leak.file.endsWith('control.result.json')), 'the scan found the canary in the control result');
});
