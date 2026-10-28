// A plan never holds a secret. The parser rejects with literal_secret:
//   - a fill with literal text into a field whose locator names a sensitive field (password,
//     passcode, token, secret, API key, and their German and French equivalents);
//   - a token-shaped literal anywhere in plan text: a JSON Web Token, "Bearer …", or a well-known
//     key prefix such as ghp_, sk- or AKIA.
// Counter-examples show the rules are narrow: literal text in an ordinary field, ordinary text that
// merely contains "sk", a link that mentions a password, and a secret reference all parse.
// Token-shaped values are fresh fakes generated here.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { planParser } from '@revisum/engine';
import { FAKE_TARGET, secretProject } from './secret-examples.ts';

const project = secretProject(['ACCOUNT_PASSWORD']);
const parse = planParser(project);

// A plan whose step 1 is `step`, with `meta` fields replaced by `metaFields`.
const planWith = (step: unknown, metaFields: Readonly<Record<string, string>> = {}) => ({
  version: '1.1',
  meta: { featureId: 'SECRETS-3', specReference: 'specs/secrets.md#literals', title: 'Sign in', ...metaFields },
  targets: [FAKE_TARGET],
  steps: [
    { type: 'navigate', url: '/' },
    step,
    { type: 'expect', locator: { by: 'testId', testId: 'status' }, assert: { kind: 'visible' }, criterionId: 'secrets.status-shown' },
  ],
});

const fill = (label: string, value: unknown) => ({ type: 'fill', locator: { by: 'label', label }, value });

function assertLiteralSecret(raw: unknown, path: string, literal: string): void {
  const parsed = parse(raw);
  assert.equal(parsed.ok, false, 'the plan was accepted');
  if (parsed.ok) return;
  assert.ok(parsed.error.some((error) => error.code === 'literal_secret' && error.path === path), `expected literal_secret at ${path}, got ${JSON.stringify(parsed.error)}`);
  assert.equal(JSON.stringify(parsed.error).includes(literal), false, 'the error echoes the literal');
}

function assertAccepted(raw: unknown): void {
  const parsed = parse(raw);
  assert.ok(parsed.ok, `rejected: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
}

const letters = (count: number, alphabet: RegExp): string => {
  let text = '';
  while (text.length < count) text += randomBytes(32).toString('base64').replace(alphabet, '');
  return text.slice(0, count);
};
const base64url = (text: string): string => Buffer.from(text).toString('base64url');

// Fresh token-shaped fakes, one per shape the rule names.
const TOKEN_SHAPES: readonly { readonly shape: string; readonly make: () => string }[] = [
  { shape: 'a JSON Web Token', make: () => `${base64url('{"alg":"HS256","typ":"JWT"}')}.${base64url(`{"sub":"${letters(8, /[^a-z0-9]/g)}"}`)}.${randomBytes(24).toString('base64url')}` },
  { shape: 'a Bearer token', make: () => `Bearer ${randomBytes(24).toString('base64url')}` },
  { shape: 'a ghp_ key', make: () => `ghp_${letters(36, /[^A-Za-z0-9]/g)}` },
  { shape: 'an sk- key', make: () => `sk-${letters(40, /[^A-Za-z0-9]/g)}` },
  { shape: 'an AKIA key', make: () => `AKIA${letters(16, /[^A-Z0-9]/g)}` },
];

// ---- Literal text in a sensitive field ----------------------------------------------------------

const SENSITIVE_LABELS = ['Password', 'Passcode', 'Access token', 'Client secret', 'API key', 'Passwort', 'Mot de passe'];

for (const label of SENSITIVE_LABELS) {
  test(`a fill with literal text into the "${label}" field is rejected as literal_secret`, { criterion: 'AC-SPEC-04-03' }, () => {
    const literal = `horse ${letters(10, /[^a-z]/g)} staple`;
    assertLiteralSecret(planWith(fill(label, literal)), '$.steps[1].value', literal);
  });
}

test('a fill with literal text into a textbox whose accessible name is Password is rejected as literal_secret', { criterion: 'AC-SPEC-04-03' }, () => {
  const literal = `horse ${letters(10, /[^a-z]/g)} staple`;
  const step = { type: 'fill', locator: { by: 'role', role: 'textbox', name: 'Password' }, value: literal };
  assertLiteralSecret(planWith(step), '$.steps[1].value', literal);
});

test('a fill into a sensitive field inside a frame is rejected as literal_secret', { criterion: 'AC-SPEC-04-03' }, () => {
  const literal = `horse ${letters(10, /[^a-z]/g)} staple`;
  const step = { type: 'frame', locator: { by: 'testId', testId: 'login-frame' }, steps: [fill('Password', literal)] };
  assertLiteralSecret(planWith(step), '$.steps[1].steps[0].value', literal);
});

// ---- Token-shaped literals anywhere -------------------------------------------------------------

for (const token of TOKEN_SHAPES) {
  test(`${token.shape} typed into an ordinary field is rejected as literal_secret`, { criterion: 'AC-SPEC-04-03' }, () => {
    const literal = token.make();
    assertLiteralSecret(planWith(fill('Full name', literal)), '$.steps[1].value', literal);
  });
}

test('token-shaped literals in a title, an expected text, an option and a locator name are rejected as literal_secret', { criterion: 'AC-SPEC-04-03' }, () => {
  const [jwt, bearer, github, openKey, cloudKey] = TOKEN_SHAPES.map((token) => token.make());
  assert.ok(jwt !== undefined && bearer !== undefined && github !== undefined && openKey !== undefined && cloudKey !== undefined);
  assertLiteralSecret(planWith(fill('Full name', 'Ada Lovelace'), { title: `Uses ${openKey}` }), '$.meta.title', openKey);
  assertLiteralSecret(planWith({
    type: 'expect', locator: { by: 'testId', testId: 'header' }, assert: { kind: 'textContains', value: bearer }, criterionId: 'secrets.header',
  }), '$.steps[1].assert.value', bearer);
  assertLiteralSecret(planWith({ type: 'select', locator: { by: 'label', label: 'Key' }, option: github }), '$.steps[1].option', github);
  assertLiteralSecret(planWith({ type: 'click', locator: { by: 'role', role: 'button', name: cloudKey } }), '$.steps[1].locator.name', cloudKey);
  assertLiteralSecret(planWith({ type: 'click', locator: { by: 'text', text: jwt } }), '$.steps[1].locator.text', jwt);
});

// ---- Counter-examples ---------------------------------------------------------------------------

test('counter-example: literal text in an ordinary field parses', { criterion: 'AC-SPEC-04-03' }, () => {
  assertAccepted(planWith(fill('Full name', 'Ada Lovelace')));
  assertAccepted(planWith(fill('Email', 'ada@example.test')));
});

test('counter-example: ordinary text that merely contains "sk" parses', { criterion: 'AC-SPEC-04-03' }, () => {
  assertAccepted(planWith(fill('Search', 'Ask a question about the task-list')));
  assertAccepted(planWith({
    type: 'expect', locator: { by: 'testId', testId: 'banner' }, assert: { kind: 'textContains', value: 'Desk booking is risk-free' }, criterionId: 'secrets.banner',
  }, { title: 'Book a desk' }));
});

test('counter-example: a click on a link that mentions a password parses', { criterion: 'AC-SPEC-04-03' }, () => {
  assertAccepted(planWith({ type: 'click', locator: { by: 'role', role: 'link', name: 'Forgot password?' } }));
});

test('counter-example: a secret reference in the Password field parses', { criterion: 'AC-SPEC-04-03' }, () => {
  assertAccepted(planWith(fill('Password', { secretName: 'ACCOUNT_PASSWORD' })));
});
