// Field names in code style still name sensitive fields. A locator written as a test id or a CSS
// selector names its field the way the page's code does: "authToken", "client_secret",
// "#access_token". Literal text filled into such a field is a literal secret, just as it is for a
// field labelled "Access token", and the parser rejects it with literal_secret without echoing the
// text. Counter-examples: fields whose code-style names hold no sensitive word still take literal text.
// See docs/specs/SPEC-04-secrets-and-redaction.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planParser, type Plan, type PlanError, type Result } from '@revisum/engine';
import { FAKE_TARGET, secretProject } from './secret-examples.ts';
import { parserEnabling } from './unsafe-feature-examples.ts';
import { OPEN_CART, css, unsafePlan } from './unsafe-feature-steps.ts';

type Parse = (input: unknown) => Result<Plan, readonly PlanError[]>;

const LITERAL = 'horse battery staple';
const parseClosed: Parse = planParser(secretProject(['ACCOUNT_PASSWORD']));
const parseWithCss: Parse = parserEnabling(['css-locator']);

// A closed (1.1) plan that fills `locator` with literal text.
const closedFill = (locator: unknown) => ({
  version: '1.1',
  meta: { featureId: 'SECRETS-4', specReference: 'specs/secrets.md#field-names', title: 'Sign in' },
  targets: [FAKE_TARGET],
  steps: [
    { type: 'navigate', url: '/' },
    { type: 'fill', locator, value: LITERAL },
    { type: 'expect', locator: { by: 'testId', testId: 'status' }, assert: { kind: 'visible' }, criterionId: 'secrets.status-shown' },
  ],
});
// A 1.3 plan, with CSS locators enabled, that fills `locator` with literal text.
const cssFill = (selector: string) => unsafePlan([OPEN_CART, { type: 'fill', locator: css(selector), value: LITERAL }]);

type FieldCase = { readonly title: string; readonly parse: Parse; readonly plan: unknown };

const SENSITIVE: readonly FieldCase[] = [
  { title: 'a test id "authToken"', parse: parseClosed, plan: closedFill({ by: 'testId', testId: 'authToken' }) },
  { title: 'a test id "client_secret"', parse: parseClosed, plan: closedFill({ by: 'testId', testId: 'client_secret' }) },
  { title: 'a test id "userPassword"', parse: parseClosed, plan: closedFill({ by: 'testId', testId: 'userPassword' }) },
  { title: 'a CSS selector input[name="client_secret"]', parse: parseWithCss, plan: cssFill('input[name="client_secret"]') },
  { title: 'a CSS selector #access_token', parse: parseWithCss, plan: cssFill('#access_token') },
  { title: 'a CSS selector input[name="apiKey"]', parse: parseWithCss, plan: cssFill('input[name="apiKey"]') },
];

const ORDINARY: readonly FieldCase[] = [
  { title: 'a test id "username"', parse: parseClosed, plan: closedFill({ by: 'testId', testId: 'username' }) },
  { title: 'a test id "displayName"', parse: parseClosed, plan: closedFill({ by: 'testId', testId: 'displayName' }) },
  { title: 'a CSS selector input[name="first_name"]', parse: parseWithCss, plan: cssFill('input[name="first_name"]') },
  { title: 'a CSS selector #postal_code', parse: parseWithCss, plan: cssFill('#postal_code') },
];

for (const field of SENSITIVE) {
  test(`a fill with literal text into the field named by ${field.title} is rejected as literal_secret`, { criterion: 'AC-SPEC-04-03' }, () => {
    const parsed = field.parse(field.plan);
    assert.equal(parsed.ok, false, 'the plan was accepted');
    if (parsed.ok) return;
    assert.ok(parsed.error.some((error) => error.code === 'literal_secret' && error.path === '$.steps[1].value'), JSON.stringify(parsed.error));
    assert.equal(JSON.stringify(parsed.error).includes(LITERAL), false, 'the error echoes the literal');
  });
}

for (const field of ORDINARY) {
  test(`counter-example: a fill with literal text into the field named by ${field.title} parses`, { criterion: 'AC-SPEC-04-03' }, () => {
    const parsed = field.parse(field.plan);
    assert.ok(parsed.ok, `rejected: ${parsed.ok ? '' : JSON.stringify(parsed.error)}`);
  });
}
