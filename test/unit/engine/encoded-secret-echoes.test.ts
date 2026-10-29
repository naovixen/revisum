// Secrets echo in encodings beyond the plain ones: inside a longer base64 string, such as a Basic
// authorisation header holding "user:password", at any of the three byte alignments the secret can
// take there; form-encoded, as a browser submits a form or URLSearchParams writes it (spaces as
// "+", "!" and "~" escaped); and percent-encoded with lower-case hex. Short secrets of eight to ten
// characters are included, since their base64 is short too. For each echo the leak scanner must
// report it, and a run whose page shows it must keep no decodable trace of it. The trace is judged
// by holdsSecret (echo-page-driver.ts), which decodes kept text on its own, without the engine.
// Counter-examples: a near miss in the same encoding is neither reported nor redacted.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { leakScanner } from '@revisum/engine';
import { echoPageDriver, holdsSecret } from './echo-page-driver.ts';
import { FAKE_TARGET, resolvedSecret, runWithSecrets } from './secret-examples.ts';

let folder: string;
before(() => { folder = mkdtempSync(join(tmpdir(), 'encoded-secret-echoes-')); });
after(() => { rmSync(folder, { recursive: true, force: true }); });

const SECRET = 'ACCOUNT_PASSWORD';
const base64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const formEncoded = (value: string): string => new URLSearchParams({ password: value }).toString();
const lowerCaseEscapes = (text: string): string => text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());

type Echo = { readonly title: string; readonly secret: string; readonly text: string };

// Base64 of "user:secret", optionally followed by more text, for user names of 3, 4 and 5 bytes,
// so the secret starts at byte offset 0, 1 and 2 within a three-byte base64 group.
const USERS = [{ name: 'al:', offset: 0 }, { name: 'bob:', offset: 1 }, { name: 'carl:', offset: 2 }] as const;
const BASE64_ECHOES: readonly Echo[] = ['hunter22', 'hunter22a', 'hunter22ab'].flatMap((secret) => USERS.flatMap((user) =>
  ['', '@v=1'].map((after): Echo => ({
    title: `"${secret}" (${secret.length} bytes) at offset ${user.offset} in base64 of "${user.name}${secret}${after}"`,
    secret, text: `Authorization: Basic ${base64(`${user.name}${secret}${after}`)}`,
  }))));

const PERCENT_ECHOES: readonly Echo[] = [
  { title: 'a passphrase form-encoded with "+" for spaces', secret: 'correct horse battery', text: 'POST body: password=correct+horse+battery' },
  { title: 'a secret written by URLSearchParams, "!" and "~" escaped', secret: 'Hunter2!Secret~', text: `POST body: ${formEncoded('Hunter2!Secret~')}` },
  { title: 'a nine-character secret form-encoded', secret: 'tea time!', text: `POST body: ${formEncoded('tea time!')}` },
  { title: 'a secret percent-encoded with lower-case hex', secret: 'ab/cd/ef/gh', text: `GET /next?path=${lowerCaseEscapes(encodeURIComponent('ab/cd/ef/gh'))}` },
  { title: 'a ten-character secret form-encoded with lower-case hex', secret: 'pa/ss w0rd', text: `POST body: ${lowerCaseEscapes(formEncoded('pa/ss w0rd'))}` },
];

const NEAR_MISSES: readonly Echo[] = [
  { title: 'base64 of "bob:hunter23" for the secret "hunter22"', secret: 'hunter22', text: `Authorization: Basic ${base64('bob:hunter23')}` },
  { title: 'base64 of "al:hunter23@v=1" for the secret "hunter22"', secret: 'hunter22', text: `Authorization: Basic ${base64('al:hunter23@v=1')}` },
  { title: 'another passphrase form-encoded', secret: 'correct horse battery', text: 'POST body: password=tea+and+biscuits' },
  { title: 'another path with lower-case escapes', secret: 'ab/cd/ef/gh', text: 'GET /next?path=%2fhome%2fada' },
];

let planted = 0;
function plant(content: string): string {
  planted += 1;
  const path = join(folder, `echo-${planted}.log`);
  writeFileSync(path, content);
  return path;
}

// A run that types the secret, then checks an element whose text is `text` against a text it can
// never equal, so the failed step keeps what it observed.
async function observedAfterEcho(secretValue: string, text: string): Promise<{ readonly observed: string; readonly everything: string }> {
  const plan = {
    version: '1.1',
    meta: { featureId: 'SECRETS-6', specReference: 'specs/secrets.md#encodings', title: 'Encoded echoes' },
    targets: [FAKE_TARGET],
    steps: [
      { type: 'navigate', url: '/' },
      { type: 'fill', locator: { by: 'label', label: 'Password' }, value: { secretName: SECRET } },
      { type: 'expect', locator: { by: 'testId', testId: 'echo' }, assert: { kind: 'textEquals', value: 'deliberately wrong' }, criterionId: 'secrets.echo-checked' },
    ],
  };
  const driver = echoPageDriver({ secretValues: { [SECRET]: secretValue }, texts: { echo: text } });
  const ran = await runWithSecrets([SECRET], plan, { [SECRET]: secretValue }, driver);
  const check = ran.result.steps[2];
  assert.equal(check?.outcome, 'failed', JSON.stringify(ran.result.steps));
  assert.ok(check?.observed !== undefined && check.observed.length > 0, 'the failed check kept an observation');
  return { observed: check.observed, everything: ran.everything };
}

for (const echo of [...BASE64_ECHOES, ...PERCENT_ECHOES]) {
  test(`the scanner reports ${echo.title}`, { criterion: 'AC-SPEC-04-04' }, () => {
    assert.ok(holdsSecret(echo.text, echo.secret), 'setup: the planted text does hold the secret');
    const secret = resolvedSecret(SECRET, echo.secret);
    const path = plant(echo.text);
    const leaks = leakScanner().scan([path], [secret]);
    assert.ok(leaks.some((leak) => leak.secret === secret.name && leak.file === path), `no leak reported in: ${echo.text}`);
  });

  test(`a run whose page shows ${echo.title} keeps no decodable trace of it`, { criterion: 'AC-SPEC-04-04' }, async () => {
    const { observed, everything } = await observedAfterEcho(echo.secret, echo.text);
    assert.equal(holdsSecret(observed, echo.secret), false, `the observation still holds the secret: ${observed}`);
    assert.equal(holdsSecret(everything, echo.secret), false, 'the result or the event log still holds the secret');
  });
}

for (const nearMiss of NEAR_MISSES) {
  test(`counter-example: the scanner reports nothing for ${nearMiss.title}`, { criterion: 'AC-SPEC-04-04' }, () => {
    assert.equal(holdsSecret(nearMiss.text, nearMiss.secret), false, 'setup: the planted text does not hold the secret');
    const path = plant(nearMiss.text);
    assert.deepEqual(leakScanner().scan([path], [resolvedSecret(SECRET, nearMiss.secret)]), []);
  });

  test(`counter-example: a run whose page shows ${nearMiss.title} keeps it as observed`, { criterion: 'AC-SPEC-04-04' }, async () => {
    const { observed } = await observedAfterEcho(nearMiss.secret, nearMiss.text);
    assert.equal(observed, nearMiss.text);
  });
}
