// The leak scanner finds a secret's echoes in files: raw, URI-encoded, base64, base64url, cut to
// a prefix and with its case changed, in text and in image bytes. Each form is planted in its own
// file; clean files and other secrets are counter-examples, so a scanner that reports everything
// or nothing fails. The run-wide scan with its planted canary is in test/proofs/secret-leak-scan.test.ts.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { leakScanner, type Leak } from '@revisum/engine';
import { echoForms, fakeSecretValue, resolvedSecret, type LeakForm } from './secret-examples.ts';

let folder: string;
before(() => { folder = mkdtempSync(join(tmpdir(), 'leak-scanner-')); });
after(() => { rmSync(folder, { recursive: true, force: true }); });

// Writes a file in the test folder and returns its path.
function plant(fileName: string, content: string | Uint8Array): string {
  const path = join(folder, fileName);
  writeFileSync(path, content);
  return path;
}

const leaksIn = (leaks: readonly Leak[], path: string): readonly Leak[] =>
  leaks.filter((leak) => leak.file === path || leak.file.endsWith(path.split(/[\\/]/).at(-1) ?? path));

// One file per planted echo, the form the scanner must report for it.
const PLANTED: readonly { readonly fileName: string; readonly form: LeakForm; readonly echo: (value: string) => string }[] = [
  { fileName: 'raw.json', form: 'raw', echo: (value) => JSON.stringify({ observed: `Signed in as ${value}` }) },
  { fileName: 'uri.log', form: 'uri', echo: (value) => `GET /callback?token=${echoForms(value).uri}&next=%2F\n` },
  { fileName: 'base64.txt', form: 'base64', echo: (value) => `Authorization: Basic ${echoForms(value).base64}\n` },
  { fileName: 'base64url.txt', form: 'base64url', echo: (value) => `state=${echoForms(value).base64url}\n` },
  { fileName: 'prefix.log', form: 'prefix', echo: (value) => `token ${echoForms(value).prefix}... (truncated)\n` },
  { fileName: 'upper.html', form: 'case', echo: (value) => `<p>${echoForms(value).upper}</p>\n` },
  { fileName: 'lower.html', form: 'case', echo: (value) => `<p>${echoForms(value).lower}</p>\n` },
];

for (const planted of PLANTED) {
  test(`the scanner reports a ${planted.form} echo planted in ${planted.fileName}, naming the file and the secret`, { criterion: 'AC-SPEC-04-04' }, () => {
    const value = fakeSecretValue();
    const secret = resolvedSecret('ACCOUNT_TOKEN', value);
    const path = plant(planted.fileName, planted.echo(value));
    const found = leaksIn(leakScanner().scan([path], [secret]), path);
    assert.ok(found.length > 0, `no leak reported for the ${planted.form} echo`);
    assert.ok(found.some((leak) => leak.form === planted.form), `forms reported: ${found.map((leak) => leak.form).join(', ')}`);
    assert.ok(found.every((leak) => leak.secret === secret.name), 'every leak names the planted secret');
  });
}

test('the scanner reports a raw echo inside image bytes, such as a PNG text chunk', { criterion: 'AC-SPEC-04-04' }, () => {
  const value = fakeSecretValue();
  const secret = resolvedSecret('ACCOUNT_TOKEN', value);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  const textChunk = new TextEncoder().encode(`\u0000\u0000\u0000@tEXtComment\u0000${value}`);
  const path = plant('screenshot.png', new Uint8Array([...signature, ...textChunk, 0, 0, 0, 0]));
  const found = leaksIn(leakScanner().scan([path], [secret]), path);
  assert.ok(found.some((leak) => leak.form === 'raw'), `forms reported: ${found.map((leak) => leak.form).join(', ')}`);
});

test('the scanner reports every planted file at once and nothing in the clean ones', { criterion: 'AC-SPEC-04-04' }, () => {
  const value = fakeSecretValue();
  const secret = resolvedSecret('ACCOUNT_TOKEN', value);
  const plantedPaths = PLANTED.map((planted) => plant(`all-${planted.fileName}`, planted.echo(value)));
  const cleanPaths = [
    plant('clean-result.json', JSON.stringify({ state: 'Passed', steps: [{ index: 0, outcome: 'passed' }] })),
    plant('clean-events.jsonl', '{"kind":"run.state","state":"Running"}\n{"kind":"step.end","outcome":"passed"}\n'),
  ];
  const leaks = leakScanner().scan([...plantedPaths, ...cleanPaths], [secret]);
  for (const path of plantedPaths) assert.ok(leaksIn(leaks, path).length > 0, `nothing reported in ${path}`);
  for (const path of cleanPaths) assert.deepEqual(leaksIn(leaks, path), [], `a leak reported in clean file ${path}`);
});

test('counter-example: another secret of the same shape in a file is not reported as this one', { criterion: 'AC-SPEC-04-04' }, () => {
  const ours = resolvedSecret('ACCOUNT_TOKEN', fakeSecretValue());
  const otherValue = fakeSecretValue();
  const path = plant('other-secret.json', JSON.stringify({ observed: otherValue, encoded: echoForms(otherValue).base64 }));
  assert.deepEqual(leakScanner().scan([path], [ours]), []);
});

test('counter-example: with no secrets to look for, a file holding a value reports nothing', { criterion: 'AC-SPEC-04-04' }, () => {
  const path = plant('unwatched.json', JSON.stringify({ observed: fakeSecretValue() }));
  assert.deepEqual(leakScanner().scan([path], []), []);
});

test('the scanner tells two secrets apart and names the one each file echoes', { criterion: 'AC-SPEC-04-04' }, () => {
  const firstValue = fakeSecretValue();
  const secondValue = fakeSecretValue();
  const first = resolvedSecret('ACCOUNT_TOKEN', firstValue);
  const second = resolvedSecret('SERVICE_KEY', secondValue);
  const firstPath = plant('first.json', JSON.stringify({ observed: firstValue }));
  const secondPath = plant('second.txt', `key=${echoForms(secondValue).uri}`);
  const leaks = leakScanner().scan([firstPath, secondPath], [first, second]);
  assert.deepEqual([...new Set(leaksIn(leaks, firstPath).map((leak) => leak.secret))], [first.name]);
  assert.deepEqual([...new Set(leaksIn(leaks, secondPath).map((leak) => leak.secret))], [second.name]);
});
