// The policy gate over unsafe features. Its static check denies a proposal (a plan with no
// approval) that holds an inline script (inline-script-in-proposal), or a write script or write
// database command whose declaration does not allow it in proposals (side-effect-in-proposal), and
// any database command whose service is on a production origin (production-origin). A denied plan
// runs no script and no command. The runtime guard judges every element a CSS or XPath locator
// resolves, as it judges any other: a control named "Delete account" is irreversible whatever
// selector found it, and a control with no accessible name is refused unless the project lists
// that exact selector or expression in unnamedControlsAllowed.
// See docs/specs/SPEC-36-unsafe-plan-features.md and docs/specs/SPEC-03-policy-gate.md.
import assert from 'node:assert/strict';
import { arch, platform } from 'node:os';
import { test } from 'node:test';
import { defaultRedactor, runUntrusted, type Plan } from '@revisum/engine';
import { memoryArtifactStore, memoryRunEventSink, systemClock } from '../../support/memory-ports.ts';
import { TEST_SERVICE } from './plan-examples.ts';
import {
  ALLOWED, PROPOSAL, approvedStanding, comparable, decideOn, deniedCodes, denied, element, localeOf, parsedPlan, parserProject, stepAt,
  testGate,
} from './policy-examples.ts';
import { spyDriver } from './secret-examples.ts';
import {
  ALLOWED_UNNAMED_SELECTOR, CART_COUNT_CHECK, CLEAR_EDITOR, DATABASE_COMMANDS, DATABASE_SERVICE, FEATURES, INLINE_READ, OPEN_CART, ORDER_COUNT_CHECK,
  ORIGIN, READ_CART, SEED_EDITOR, SEED_ORDERS, TARGET_ID, WIPE_ORDERS, css, unsafePlan, unsafeProjectFile, unsafeSection, xpath,
  type JsonRecord,
} from './unsafe-feature-steps.ts';

// The shared unsafe project, every feature on, with its one target in British English so the
// engine's English irreversible patterns apply.
const ENGLISH_TARGET: JsonRecord = {
  id: TARGET_ID, adapter: 'playwright', engine: 'chromium', device: 'desktop-1280',
  locale: 'en-GB', timezone: 'Europe/London', colorScheme: 'light', reducedMotion: 'reduce',
};
const PROJECT = unsafeProjectFile(FEATURES, { matrix: [ENGLISH_TARGET] });

type DecideOptions = { readonly approved?: boolean; readonly projectFile?: JsonRecord };

async function decide(raw: JsonRecord, options: DecideOptions = {}) {
  const projectFile = options.projectFile ?? PROJECT;
  const tested = await testGate(projectFile);
  const plan = parsedPlan(raw, projectFile);
  const standing = options.approved === true ? await approvedStanding(plan) : PROPOSAL;
  return { decision: comparable(decideOn(tested, plan, standing)), events: tested.events };
}

// ---- Inline scripts in proposals ---------------------------------------------------------------

test('a proposal holding an inline script is denied with inline-script-in-proposal at its step', { criterion: 'AC-SPEC-36-08' }, async () => {
  const { decision, events } = await decide(unsafePlan([OPEN_CART, INLINE_READ]));
  assert.deepEqual(decision, denied('inline-script-in-proposal', 1));
  assert.deepEqual(deniedCodes(events), ['inline-script-in-proposal']);
});

test('a proposal whose inline script is inside a frame is denied at the frame\'s step', { criterion: 'AC-SPEC-36-08' }, async () => {
  const plan = unsafePlan([OPEN_CART, { type: 'frame', locator: css('iframe.editor-canvas'), steps: [INLINE_READ] }]);
  assert.deepEqual((await decide(plan)).decision, denied('inline-script-in-proposal', 1));
});

test('even a read-only inline script is denied in a proposal: its effect is the plan\'s own claim', { criterion: 'AC-SPEC-36-08' }, async () => {
  // INLINE_READ declares effect "read"; the rule does not trust that.
  assert.equal(((INLINE_READ['script'] as JsonRecord)['inline'] as JsonRecord)['effect'], 'read');
  assert.equal((await decide(unsafePlan([OPEN_CART, INLINE_READ]))).decision['rule'], 'inline-script-in-proposal');
});

// Counter-examples: the same inline script in an approved plan, and named read scripts in proposals.
test('the same inline script in an approved plan is allowed', { criterion: 'AC-SPEC-36-08' }, async () => {
  assert.deepEqual((await decide(unsafePlan([OPEN_CART, INLINE_READ]), { approved: true })).decision, ALLOWED);
});

test('a proposal may run a named read script and a page-script check', { criterion: 'AC-SPEC-36-08' }, async () => {
  assert.deepEqual((await decide(unsafePlan([OPEN_CART, READ_CART, CART_COUNT_CHECK]))).decision, ALLOWED);
});

// ---- Write scripts and write commands in proposals ------------------------------------------------

test('a proposal running a write script whose declaration lacks allowInProposals is denied with side-effect-in-proposal', { criterion: 'AC-SPEC-36-08' }, async () => {
  const { decision, events } = await decide(unsafePlan([OPEN_CART, CLEAR_EDITOR]));
  assert.deepEqual(decision, denied('side-effect-in-proposal', 1));
  assert.deepEqual(deniedCodes(events), ['side-effect-in-proposal']);
});

test('a proposal running a write command whose declaration lacks allowInProposals is denied with side-effect-in-proposal', { criterion: 'AC-SPEC-36-08' }, async () => {
  const { decision, events } = await decide(unsafePlan([OPEN_CART, WIPE_ORDERS]));
  assert.deepEqual(decision, denied('side-effect-in-proposal', 1));
  assert.deepEqual(deniedCodes(events), ['side-effect-in-proposal']);
});

test('a proposal whose only such write command is in cleanup is denied with side-effect-in-proposal too', { criterion: 'AC-SPEC-36-08' }, async () => {
  const { decision } = await decide(unsafePlan([OPEN_CART], { cleanup: [WIPE_ORDERS] }));
  assert.equal(decision['kind'], 'deny');
  assert.equal(decision['rule'], 'side-effect-in-proposal');
});

// Counter-examples: writes their declarations allow in proposals, and the same writes approved.
test('a proposal may run a write script and a write command whose declarations set allowInProposals', { criterion: 'AC-SPEC-36-08' }, async () => {
  assert.deepEqual((await decide(unsafePlan([OPEN_CART, SEED_EDITOR, SEED_ORDERS], { cleanup: [SEED_ORDERS] }))).decision, ALLOWED);
});

test('a proposal may run a read command as a database check', { criterion: 'AC-SPEC-36-08' }, async () => {
  assert.deepEqual((await decide(unsafePlan([OPEN_CART, ORDER_COUNT_CHECK]))).decision, ALLOWED);
});

test('the same write script and write command in an approved plan are allowed', { criterion: 'AC-SPEC-36-08' }, async () => {
  assert.deepEqual((await decide(unsafePlan([OPEN_CART, CLEAR_EDITOR, WIPE_ORDERS], { cleanup: [WIPE_ORDERS] }), { approved: true })).decision, ALLOWED);
});

// ---- Nothing runs for a denied plan ---------------------------------------------------------------

test('a plan the gate denies for any of these rules opens no browser, so no script or command runs', { criterion: 'AC-SPEC-36-08' }, async () => {
  const project = parserProject(PROJECT);
  const spy = spyDriver();
  const ports = { drivers: new Map([['playwright', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), events: memoryRunEventSink() };
  const base = { project, baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() } };
  const parse = (raw: unknown) => ({ ok: true as const, value: parsedPlan(raw as JsonRecord, PROJECT) });
  const rules: string[] = [];
  for (const raw of [unsafePlan([OPEN_CART, INLINE_READ]), unsafePlan([OPEN_CART, CLEAR_EDITOR]), unsafePlan([OPEN_CART], { cleanup: [WIPE_ORDERS] })]) {
    const outcome = await runUntrusted(raw, parse, base, ports);
    assert.ok('rule' in outcome, JSON.stringify(outcome));
    if ('rule' in outcome) rules.push(outcome.rule);
  }
  assert.deepEqual(rules, ['inline-script-in-proposal', 'side-effect-in-proposal', 'side-effect-in-proposal']);
  assert.equal(spy.opens, 0, 'a browser was opened');
});

// ---- Commands on production --------------------------------------------------------------------------

const PRODUCTION_ORIGIN = 'https://shop.example.com';
// The live shop's database, on the project's production origin.
const LIVE_DATABASE: JsonRecord = { name: 'live-database', origin: PRODUCTION_ORIGIN, private: true, port: 5432 };
const LIVE_COMMANDS: JsonRecord = {
  ...DATABASE_COMMANDS,
  countLiveOrders: { ...(DATABASE_COMMANDS['countOrders'] as JsonRecord), service: 'live-database' },
};
const PRODUCTION_PROJECT = unsafeProjectFile(FEATURES, {
  matrix: [ENGLISH_TARGET], origins: [ORIGIN, PRODUCTION_ORIGIN], productionOrigins: [PRODUCTION_ORIGIN],
  services: [TEST_SERVICE, DATABASE_SERVICE, LIVE_DATABASE],
  unsafeFeatures: { ...unsafeSection(FEATURES), databaseCommands: { commands: LIVE_COMMANDS } },
});
const LIVE_COUNT_CHECK: JsonRecord = { ...ORDER_COUNT_CHECK, command: 'countLiveOrders' };

test('a database command whose service is on a production origin is denied with production-origin, in a proposal', { criterion: 'AC-SPEC-36-13' }, async () => {
  const { decision, events } = await decide(unsafePlan([OPEN_CART, LIVE_COUNT_CHECK]), { projectFile: PRODUCTION_PROJECT });
  assert.deepEqual(decision, denied('production-origin', 1));
  assert.deepEqual(deniedCodes(events), ['production-origin']);
});

test('a database command whose service is on a production origin is denied in an approved plan too', { criterion: 'AC-SPEC-36-13' }, async () => {
  const { decision } = await decide(unsafePlan([OPEN_CART, LIVE_COUNT_CHECK]), { projectFile: PRODUCTION_PROJECT, approved: true });
  assert.deepEqual(decision, denied('production-origin', 1));
});

test('a production command is denied before anything starts: no browser is opened', { criterion: 'AC-SPEC-36-13' }, async () => {
  const spy = spyDriver();
  const ports = { drivers: new Map([['playwright', spy]]), clock: systemClock, artifacts: memoryArtifactStore(), redactor: defaultRedactor(), events: memoryRunEventSink() };
  const base = {
    project: parserProject(PRODUCTION_PROJECT), baseUrl: ORIGIN, seed: 42, fixedTimeMilliseconds: 0, fixtures: [], host: { platform: platform(), arch: arch() },
  };
  const parse = (raw: unknown) => ({ ok: true as const, value: parsedPlan(raw as JsonRecord, PRODUCTION_PROJECT) });
  const outcome = await runUntrusted(unsafePlan([OPEN_CART, LIVE_COUNT_CHECK]), parse, base, ports);
  assert.ok('rule' in outcome && outcome.rule === 'production-origin', JSON.stringify(outcome));
  assert.equal(spy.opens, 0);
});

// Counter-example: the same command on the private test database is allowed in the same project.
test('the same command on the test database is allowed in the same project', { criterion: 'AC-SPEC-36-13' }, async () => {
  assert.deepEqual((await decide(unsafePlan([OPEN_CART, ORDER_COUNT_CHECK]), { projectFile: PRODUCTION_PROJECT })).decision, ALLOWED);
});

// ---- The runtime guard on CSS and XPath locators -------------------------------------------------------

// The gate, a plan clicking `locator` as step 1, and the guard's verdict on the element it resolves.
async function guardClick(locator: JsonRecord, resolved: Parameters<typeof element>[0]) {
  const tested = await testGate(PROJECT);
  const plan: Plan = parsedPlan(unsafePlan([OPEN_CART, { type: 'click', locator }]), PROJECT);
  const verdict = tested.gate.guardAction(stepAt(plan, 1), 1, element(resolved), null, localeOf(tested.project, TARGET_ID));
  return { tested, plan, verdict, events: tested.events };
}

const DELETE_BUTTON = { role: 'button', name: 'Delete account' } as const;

test('the static check cannot read a name from button.danger, so it leaves the click to the runtime guard', { criterion: 'AC-SPEC-36-06' }, async () => {
  const { tested, plan } = await guardClick(css('button.danger'), DELETE_BUTTON);
  assert.deepEqual(comparable(decideOn(tested, plan)), ALLOWED);
});

test('a button named "Delete account" found by button.danger is denied irreversible-action by the runtime guard', { criterion: 'AC-SPEC-36-06' }, async () => {
  const { verdict, events } = await guardClick(css('button.danger'), DELETE_BUTTON);
  assert.deepEqual(verdict, { kind: 'deny', rule: 'irreversible-action', stepIndex: 1 });
  assert.deepEqual(deniedCodes(events), ['irreversible-action']);
});

test('the same button found by an XPath expression is denied irreversible-action too', { criterion: 'AC-SPEC-36-06' }, async () => {
  const { verdict } = await guardClick(xpath('//form//button[2]'), DELETE_BUTTON);
  assert.deepEqual(verdict, { kind: 'deny', rule: 'irreversible-action', stepIndex: 1 });
});

// Counter-example: the same selector resolving a harmless control is allowed.
test('button.danger resolving a button named "Show details" is allowed', { criterion: 'AC-SPEC-36-06' }, async () => {
  const { verdict } = await guardClick(css('button.danger'), { role: 'button', name: 'Show details' });
  assert.deepEqual(verdict, ALLOWED);
});

test('an unnamed control found by a CSS selector the project does not list is denied unnamed-control', { criterion: 'AC-SPEC-36-06' }, async () => {
  const { verdict } = await guardClick(css('button.icon-trash'), { role: 'button', name: null });
  assert.deepEqual(verdict, { kind: 'deny', rule: 'unnamed-control', stepIndex: 1 });
});

test('an unnamed control found by an XPath expression the project does not list is denied unnamed-control', { criterion: 'AC-SPEC-36-06' }, async () => {
  const { verdict } = await guardClick(xpath('//header//button[1]'), { role: 'button', name: '' });
  assert.deepEqual(verdict, { kind: 'deny', rule: 'unnamed-control', stepIndex: 1 });
});

test('an unnamed control found by the exact selector in unnamedControlsAllowed is allowed', { criterion: 'AC-SPEC-36-06' }, async () => {
  const { verdict } = await guardClick(css(ALLOWED_UNNAMED_SELECTOR), { role: 'button', name: null });
  assert.deepEqual(verdict, ALLOWED);
});

test('a selector that only contains or resembles the listed one is not allowed: the match is exact', { criterion: 'AC-SPEC-36-06' }, async () => {
  for (const near of [`header ${ALLOWED_UNNAMED_SELECTOR}`, `${ALLOWED_UNNAMED_SELECTOR}.large`, ALLOWED_UNNAMED_SELECTOR.toUpperCase()]) {
    const { verdict } = await guardClick(css(near), { role: 'button', name: null });
    assert.deepEqual(verdict, { kind: 'deny', rule: 'unnamed-control', stepIndex: 1 }, near);
  }
});
