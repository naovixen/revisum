// A downloaded file's content never reaches what a run keeps. The fixture server's contacts CSV
// holds a planted secret token and canary personal data: a person's name, an email address and a
// card number. A run on the own CDP driver downloads it and checks it, so the file was read. The
// leak scan then runs over the run's result, its event log, its audit events and its images,
// beside a planted copy of each canary: it must find them only where they were planted. The
// result keeps the file's sha256 instead.
// A failing content check keeps none of the file's text in its observation. With the project's
// evidence.keepDownloads on, the scan finds no canary either; and until privacy masking lands
// (SPEC-09, M3) no text of the file is kept at all, whatever keepDownloads says.
// Not covered here: the visual report, which a run cannot produce until the result model joins it
// (SPEC-11, SPEC-12).
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md and docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { leakScanner, sha256 } from '@revisum/engine';
import {
  CDP_TARGET, download, expectDownload, navigate, outcomes, pageStatesHarness, role, type PageRun, type PageStatesHarness,
} from '../contract/page-states-support.ts';
import { echoesIn, fakeSecretValue, resolvedSecret } from '../unit/engine/secret-examples.ts';

const TIMEOUT = 120_000;

// Canary text that begins with no step type or field name, so only an echo of the file matches it.
const PERSON = 'Quintrell Halloway';
const EMAIL = 'wren.qx7.halloway@example.org';
const CARD = '4929 3810 5521 7763';
const TOKEN = fakeSecretValue();
// A harmless row of the file, which no check names: kept text would show it.
const HARMLESS_ROW = 'Quarterly newsletter list';
const CONTACTS_TEXT = `Contact,Email,Card,Token\n${PERSON},${EMAIL},${CARD},${TOKEN}\n${HARMLESS_ROW},,,\n`;

const CANARIES = [
  { name: 'DOWNLOAD_PERSON', value: PERSON },
  { name: 'DOWNLOAD_EMAIL', value: EMAIL },
  { name: 'DOWNLOAD_CARD', value: CARD },
  { name: 'DOWNLOAD_TOKEN', value: TOKEN },
] as const;
const canarySecrets = () => CANARIES.map((canary) => resolvedSecret(canary.name, canary.value));

let keepUnset: PageStatesHarness;
let keepOn: PageStatesHarness;
let folder: string;
before(async () => {
  keepUnset = await pageStatesHarness({ contactsText: CONTACTS_TEXT });
  keepOn = await pageStatesHarness({ contactsText: CONTACTS_TEXT, keepDownloads: true });
  folder = mkdtempSync(join(tmpdir(), 'download-leak-scan-'));
});
after(async () => {
  await keepUnset.close();
  await keepOn.close();
  rmSync(folder, { recursive: true, force: true });
});

const resultText = (ran: PageRun): string => JSON.stringify(ran.result, null, 2);
const eventLines = (ran: PageRun): string => ran.events.read().map((event) => JSON.stringify(event)).join('\n');
const auditLines = (ran: PageRun): string => ran.audit.recorded.map((recorded) => JSON.stringify(recorded)).join('\n');
const everythingKept = (ran: PageRun): string => [resultText(ran), eventLines(ran), auditLines(ran)].join('\n');

// Writes the run's result, event log, audit events and images to the scan folder and returns their paths.
function writeOutputs(name: string, ran: PageRun): string[] {
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

// Asserts no form of any canary is in what the run kept, checked directly and by the engine's
// scanner, which finds each canary in its planted file.
function assertNoEcho(name: string, ran: PageRun): void {
  for (const canary of CANARIES) {
    assert.deepEqual(echoesIn(resultText(ran), canary.value), [], `${canary.name} in the result`);
    assert.deepEqual(echoesIn(eventLines(ran), canary.value), [], `${canary.name} in the event log`);
    assert.deepEqual(echoesIn(auditLines(ran), canary.value), [], `${canary.name} in the audit events`);
  }
  const outputs = writeOutputs(name, ran);
  const plantedPath = join(folder, `${name}.planted.json`);
  writeFileSync(plantedPath, JSON.stringify({ observed: CANARIES.map((canary) => `planted ${canary.value}`) }));
  const leaks = leakScanner().scan([...outputs, plantedPath], canarySecrets());
  assert.deepEqual([...new Set(leaks.filter((leak) => leak.file === plantedPath).map((leak) => leak.secret))].sort(),
    CANARIES.map((canary) => canary.name).sort(), 'the scan found every planted canary');
  assert.deepEqual(leaks.filter((leak) => leak.file !== plantedPath).map((leak) => `${leak.secret} ${leak.form} ${leak.file}`), [], 'canaries only where planted');
}

const downloadAndCheck = (harness: PageStatesHarness, contentCheck: string) => harness.runSteps(CDP_TARGET, [
  navigate('/downloads.html'),
  download('contact-list', role('link', 'Export contacts')),
  expectDownload('contact-list', { kind: 'fileNameEquals', value: 'contacts.csv' }, 'contacts.file-name'),
  expectDownload('contact-list', { kind: 'mediaTypeEquals', value: 'text/csv' }, 'contacts.media-type'),
  expectDownload('contact-list', { kind: 'sizeAtLeast', value: Buffer.byteLength(CONTACTS_TEXT) }, 'contacts.size'),
  expectDownload('contact-list', { kind: 'contentContains', value: contentCheck }, 'contacts.content'),
  { type: 'capture', name: 'after-contacts' },
]);

describe('a run that downloads a CSV of secrets and personal data', () => {
  test('the leak scan finds no canary in the result, event log, audit events or images; the result keeps the file\'s sha256', { criterion: 'AC-SPEC-31-08', timeout: TIMEOUT }, async () => {
    const ran = await downloadAndCheck(keepUnset, 'Contact,Email');
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    assert.ok(ran.store.references().length > 0, 'the run kept its capture');
    assertNoEcho('unset', ran);
    assert.ok(resultText(ran).includes(sha256(Buffer.from(CONTACTS_TEXT, 'utf8'))), 'the result holds the file\'s sha256');
    assert.ok(!everythingKept(ran).includes(HARMLESS_ROW), 'no text of the file was kept');
  });

  test('a failing content check keeps none of the file\'s text in its observation', { criterion: 'AC-SPEC-31-08', timeout: TIMEOUT }, async () => {
    const ran = await downloadAndCheck(keepUnset, 'Text the file never holds');
    assert.equal(ran.result.state, 'Failed');
    assert.deepEqual(outcomes(ran.result).slice(0, 6), [
      [0, 'passed', undefined], [1, 'passed', undefined], [2, 'passed', undefined], [3, 'passed', undefined], [4, 'passed', undefined],
      [5, 'failed', 'assertion-failed'],
    ]);
    assertNoEcho('failed-check', ran);
    assert.ok(!everythingKept(ran).includes(HARMLESS_ROW), 'no text of the file was kept');
  });

  test('with evidence.keepDownloads on, the scan still finds no canary, and no text of the file is kept before privacy masking', { criterion: 'AC-SPEC-31-08', timeout: TIMEOUT }, async () => {
    const ran = await downloadAndCheck(keepOn, 'Contact,Email');
    assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    assertNoEcho('kept', ran);
    assert.ok(resultText(ran).includes(sha256(Buffer.from(CONTACTS_TEXT, 'utf8'))), 'the result holds the file\'s sha256');
    // Changes when SPEC-09 lands: the kept text, redacted, may then hold this harmless row.
    assert.ok(!everythingKept(ran).includes(HARMLESS_ROW), 'no text of the file was kept');
  });
});
