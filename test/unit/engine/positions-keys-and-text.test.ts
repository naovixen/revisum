// The grammar of positions, declared test-id attributes, key chords, multi-line fills and the
// URL-prefix check, and the oracle of the URL-prefix check. What a driver does with them on a real
// page (which of three buttons a position picks, exact attribute matching, the order of key
// events, the field's value after a multi-line fill) comes with the CDP driver; until then a run
// reports these steps as unsupported-step (unsupported-features.test.ts).
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkPage, parseProject, type PageAssertion } from '@revisum/engine';
import {
  OPEN_ORDERS, accepted, label, parserFor, planOf, projectFileWith, rejection, type JsonRecord,
} from './run-value-examples.ts';

const parsePlan = parserFor();
const BUTTON = (fields: JsonRecord = {}): JsonRecord => ({ by: 'role', role: 'button', name: 'Open', ...fields });
const click = (locator: JsonRecord): JsonRecord => ({ type: 'click', locator });
const expectOn = (locator: JsonRecord, assertion: JsonRecord): JsonRecord =>
  ({ type: 'expect', locator, assert: assertion, criterionId: 'orders.buttons-shown' });

// ---- Positions ----------------------------------------------------------------------------------

for (const assertion of [{ kind: 'countEquals', value: 3 }, { kind: 'absent' }]) {
  test(`${assertion.kind} on a positioned locator is refused with position_not_allowed`, { criterion: 'AC-SPEC-30-12' }, () => {
    const errors = rejection(parsePlan, planOf([OPEN_ORDERS, expectOn(BUTTON({ position: 'first' }), assertion)]));
    assert.deepEqual(errors, ['position_not_allowed $.steps[1].locator.position']);
  });

  // Counter-example: the same check without a position is accepted.
  test(`${assertion.kind} on the same locator without a position is accepted`, { criterion: 'AC-SPEC-30-12' }, () => {
    accepted(parsePlan, planOf([OPEN_ORDERS, expectOn(BUTTON(), assertion)]));
  });
}

test('first, last, 1 and 1000 are positions on every locator kind, kept as written', { criterion: 'AC-SPEC-30-12' }, () => {
  const locators = [BUTTON(), label('Quantity'), { by: 'text', text: 'Order' }, { by: 'testId', testId: 'order-row' }];
  for (const position of ['first', 'last', 1, 2, 1000]) {
    for (const locator of locators) {
      const plan = accepted(parsePlan, planOf([OPEN_ORDERS, click({ ...locator, position })]));
      const step = plan.steps[1];
      assert.ok(step?.type === 'click');
      assert.equal(step.locator.position, position);
    }
  }
});

test('a position of 0, 1001, 2.5, "second" or "2" is refused at the position', { criterion: 'AC-SPEC-30-12' }, () => {
  for (const position of [0, 1001, 2.5, 'second', '2', -1]) {
    const errors = rejection(parsePlan, planOf([OPEN_ORDERS, click(BUTTON({ position }))]));
    assert.equal(errors.length, 1, `${JSON.stringify(position)}: ${JSON.stringify(errors)}`);
    assert.ok(errors[0]?.endsWith(' $.steps[1].locator.position'), `${JSON.stringify(position)}: ${JSON.stringify(errors)}`);
  }
});

test('visible on a positioned locator is accepted, since it checks the one element picked', { criterion: 'AC-SPEC-30-12' }, () => {
  accepted(parsePlan, planOf([OPEN_ORDERS, expectOn(BUTTON({ position: 'last' }), { kind: 'visible' })]));
});

// ---- Declared test-id attributes ------------------------------------------------------------------

const byTestId = (testId: string, attribute?: unknown): JsonRecord =>
  ({ by: 'testId', testId, ...(attribute === undefined ? {} : { attribute }) });

test('a test-id locator naming an attribute the project does not declare is refused with unknown_value', { criterion: 'AC-SPEC-30-13' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, click(byTestId('save', 'data-qa'))])), ['unknown_value $.steps[1].locator.attribute']);
  const declaring = parserFor({ testIdAttributes: ['data-qa'] });
  assert.deepEqual(rejection(declaring, planOf([OPEN_ORDERS, click(byTestId('save', 'data-testid'))])), ['unknown_value $.steps[1].locator.attribute']);
});

test('a project that declares no attributes allows data-testid, and a declared attribute is accepted', { criterion: 'AC-SPEC-30-13' }, () => {
  accepted(parsePlan, planOf([OPEN_ORDERS, click(byTestId('save', 'data-testid'))]));
  const declaring = parserFor({ testIdAttributes: ['data-testid', 'data-qa', 'id'] });
  for (const attribute of ['data-testid', 'data-qa', 'id']) accepted(declaring, planOf([OPEN_ORDERS, click(byTestId('save', attribute))]));
});

const ALLOWED_ATTRIBUTES = ['id', 'data-testid', 'data-qa', 'data-test-id', 'data-cy', 'data-x1'];
const REFUSED_ATTRIBUTES = ['class', 'style', 'href', 'onclick', 'aria-label', 'name', 'data-', 'data-Test', 'data-test-', 'data--test', 'data-test id', 'data-test]', 'ID', 'data_testid'];

test('the project accepts "id" and data- attributes of lowercase words joined by single hyphens', { criterion: 'AC-SPEC-30-13' }, () => {
  const parsed = parseProject(projectFileWith({ testIdAttributes: ALLOWED_ATTRIBUTES }));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
});

for (const attribute of REFUSED_ATTRIBUTES) {
  test(`a project declaring the test-id attribute "${attribute}" fails to parse, at that entry`, { criterion: 'AC-SPEC-30-13' }, () => {
    const parsed = parseProject(projectFileWith({ testIdAttributes: ['data-testid', attribute] }));
    assert.equal(parsed.ok, false, 'the project was accepted');
    assert.ok(!parsed.ok && parsed.error.some((error) => error.path === '$.testIdAttributes[1]'), JSON.stringify(parsed));
  });
}

test('a test id holding selector syntax is accepted and kept exactly as written, never rewritten', { criterion: 'AC-SPEC-30-13' }, () => {
  for (const testId of ['"]', '*', ',', '\\', 'a"], [data-admin="1', 'save, *', 'row\\:first']) {
    const plan = accepted(parsePlan, planOf([OPEN_ORDERS, click(byTestId(testId, 'data-testid'))]));
    const step = plan.steps[1];
    assert.ok(step?.type === 'click' && step.locator.by === 'testId');
    assert.equal(step.locator.testId, testId);
  }
});

// ---- Key chords ---------------------------------------------------------------------------------

const ORDER_FIELD = label('Order number');
const press = (key: string, modifiers?: readonly unknown[]): JsonRecord =>
  ({ type: 'press', locator: ORDER_FIELD, key, ...(modifiers === undefined ? {} : { modifiers }) });

test('a repeated modifier is refused as duplicate', { criterion: 'AC-SPEC-30-14' }, () => {
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, press('k', ['Control', 'Shift', 'Control'])])), ['duplicate $.steps[1].modifiers']);
});

test('five modifiers are refused as too_large', { criterion: 'AC-SPEC-30-14' }, () => {
  const five = ['Alt', 'Control', 'Meta', 'Shift', 'ControlOrMeta'];
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, press('k', five)])), ['too_large $.steps[1].modifiers']);
});

test('an unknown modifier is refused with unknown_value at that modifier', { criterion: 'AC-SPEC-30-14' }, () => {
  for (const modifier of ['Hyper', 'control', 'Ctrl', 'Command']) {
    assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, press('k', ['Shift', modifier])])), ['unknown_value $.steps[1].modifiers[1]'], modifier);
  }
});

test('an empty modifier list is refused', { criterion: 'AC-SPEC-30-14' }, () => {
  const errors = rejection(parsePlan, planOf([OPEN_ORDERS, press('k', [])]));
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.ok(errors[0]?.endsWith(' $.steps[1].modifiers'), JSON.stringify(errors));
});

// Counter-example: one to four distinct modifiers are accepted, in the order written, which is
// the order the driver presses them down.
test('one to four distinct modifiers are accepted and kept in the order written', { criterion: 'AC-SPEC-30-14' }, () => {
  for (const modifiers of [['ControlOrMeta'], ['Shift', 'Alt'], ['Meta', 'Shift', 'Control', 'Alt']]) {
    const plan = accepted(parsePlan, planOf([OPEN_ORDERS, press('k', modifiers)]));
    const step = plan.steps[1];
    assert.ok(step?.type === 'press');
    assert.deepEqual(step.modifiers, modifiers);
  }
});

const letters = Array.from({ length: 26 }, (_unused, index) => String.fromCharCode('a'.charCodeAt(0) + index));
const digits = Array.from({ length: 10 }, (_unused, index) => String(index));
const functionKeys = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12'];
const PUNCTUATION_KEYS = ['Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash'];

test('every letter, digit, punctuation key and F1 to F12 can be pressed', { criterion: 'AC-SPEC-30-14' }, () => {
  for (const key of [...letters, ...digits, ...PUNCTUATION_KEYS, ...functionKeys, 'Enter', 'Tab']) {
    const plan = accepted(parsePlan, planOf([OPEN_ORDERS, press(key)]));
    const step = plan.steps[1];
    assert.ok(step?.type === 'press');
    assert.equal(step.key, key);
  }
});

test('an uppercase letter, F13, F0 or a typed character such as "/" is refused with unknown_value at the key', { criterion: 'AC-SPEC-30-14' }, () => {
  // Function keys outside F1 to F12, built from their number.
  for (const key of ['A', `F${13}`, `F${0}`, '/', '+', ' ', 'Control']) {
    assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, press(key)])), ['unknown_value $.steps[1].key'], JSON.stringify(key));
  }
});

// ---- Multi-line fills ---------------------------------------------------------------------------

const TIGHT_LIMITS = { maximumFillLines: 3, maximumFillCharacters: 100 };
const tight = parserFor({}, TIGHT_LIMITS);
const fillLines = (lines: readonly unknown[]): JsonRecord => ({ type: 'fill', locator: label('Message'), value: { lines } });

// A fill over its limits is refused at the offending line: the first line past the limit.
test('a fill with more lines than maximumFillLines is refused as too_large at the first line past the limit', { criterion: 'AC-SPEC-30-16' }, () => {
  assert.deepEqual(rejection(tight, planOf([OPEN_ORDERS, fillLines(['one', 'two', 'three', 'four'])])), ['too_large $.steps[1].value.lines[3]']);
});

test('with the default limits, 50 lines are accepted and 51 are refused as too_large at the 51st line', { criterion: 'AC-SPEC-30-16' }, () => {
  const lines = (count: number): string[] => Array.from({ length: count }, (_unused, index) => `Line ${index + 1}`);
  accepted(parsePlan, planOf([OPEN_ORDERS, fillLines(lines(50))]));
  assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, fillLines(lines(51))])), ['too_large $.steps[1].value.lines[50]']);
});

for (const [name, character] of [['a tab', '\t'], ['a line feed', '\n'], ['a carriage return', '\r'], ['a bell', '\u0007']] as const) {
  test(`a line holding ${name} is refused as unsafe_text at that line`, { criterion: 'AC-SPEC-30-16' }, () => {
    assert.deepEqual(rejection(tight, planOf([OPEN_ORDERS, fillLines(['Hello', `two${character}parts`])])), ['unsafe_text $.steps[1].value.lines[1]']);
  });
}

// The line breaks between lines count: 50 + 1 + 50 is 101, one over the limit of 100, although
// the lines alone hold exactly 100 characters.
test('lines totalling more than maximumFillCharacters, line breaks included, are refused as too_long at the line that crosses the limit', { criterion: 'AC-SPEC-30-16' }, () => {
  assert.deepEqual(rejection(tight, planOf([OPEN_ORDERS, fillLines(['a'.repeat(50), 'b'.repeat(50)])])), ['too_long $.steps[1].value.lines[1]']);
  assert.deepEqual(rejection(tight, planOf([OPEN_ORDERS, fillLines(['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)])])), ['too_long $.steps[1].value.lines[2]']);
});

// Counter-example: exactly the limit, line breaks included, is accepted.
test('lines of 50 and 49 characters with their line break, exactly 100, are accepted', { criterion: 'AC-SPEC-30-16' }, () => {
  accepted(tight, planOf([OPEN_ORDERS, fillLines(['a'.repeat(50), 'b'.repeat(49)])]));
});

// Counter-example: within both limits, the lines are accepted and kept in order.
test('lines within both limits are accepted and kept in order, references included', { criterion: 'AC-SPEC-30-16' }, () => {
  const lines = ['a'.repeat(40), { valueName: 'orderCode' }, 'b'.repeat(20)];
  const plan = accepted(tight, planOf([OPEN_ORDERS, fillLines(lines)], { values: { orderCode: { kind: 'uniqueText', prefix: 'order' } } }));
  const step = plan.steps[1];
  assert.ok(step?.type === 'fill');
  assert.deepEqual(step.value, { lines });
});

test('the project accepts fill limits up to 500 lines and 20,000 characters, and refuses more', { criterion: 'AC-SPEC-30-16' }, () => {
  assert.equal(parseProject(projectFileWith({}, { maximumFillLines: 500, maximumFillCharacters: 20_000 })).ok, true);
  for (const [field, value] of [['maximumFillLines', 501], ['maximumFillLines', 0], ['maximumFillCharacters', 20_001], ['maximumFillCharacters', 0]] as const) {
    const parsed = parseProject(projectFileWith({}, { [field]: value }));
    assert.equal(parsed.ok, false, `${field} ${value} was accepted`);
    assert.ok(!parsed.ok && parsed.error.some((error) => error.path === `$.limits.${field}`), JSON.stringify(parsed));
  }
});

// ---- The URL-prefix check -----------------------------------------------------------------------

const prefixCheck = (value: unknown): JsonRecord =>
  ({ type: 'expectPage', assert: { kind: 'urlPathStartsWith', value }, criterionId: 'orders.under-projects' });

test('a URL prefix that does not start with "/" is refused with invalid_url', { criterion: 'AC-SPEC-30-17' }, () => {
  for (const value of ['projects', 'https://example.com/projects', '?tab=1', ' /projects']) {
    assert.deepEqual(rejection(parsePlan, planOf([OPEN_ORDERS, prefixCheck(value)])), ['invalid_url $.steps[1].assert.value'], value);
  }
});

function prefixAssertion(value: string): PageAssertion {
  const plan = accepted(parsePlan, planOf([OPEN_ORDERS, prefixCheck(value)]));
  const step = plan.steps[1];
  assert.ok(step?.type === 'expectPage');
  return step.assert;
}

const PREFIX_CASES = [
  { prefix: '/projects', url: 'http://127.0.0.1:4173/projects', pass: true },
  { prefix: '/projects', url: 'http://127.0.0.1:4173/projects/42/settings', pass: true },
  { prefix: '/projects', url: 'http://127.0.0.1:4173/projects-archive', pass: true },
  { prefix: '/projects/', url: 'http://127.0.0.1:4173/projects', pass: false },
  { prefix: '/projects', url: 'http://127.0.0.1:4173/project', pass: false },
  { prefix: '/projects', url: 'http://127.0.0.1:4173/Projects', pass: false },
  { prefix: '/projects', url: 'http://127.0.0.1:4173/home?next=/projects', pass: false },
  { prefix: '/projects', url: 'http://127.0.0.1:4173/home#/projects', pass: false },
  { prefix: '/', url: 'http://127.0.0.1:4173/anything', pass: true },
] as const;

for (const prefixCase of PREFIX_CASES) {
  test(`the URL-prefix check "${prefixCase.prefix}" ${prefixCase.pass ? 'passes' : 'fails'} on ${prefixCase.url}`, { criterion: 'AC-SPEC-30-17' }, () => {
    const verdict = checkPage(prefixAssertion(prefixCase.prefix), { url: prefixCase.url, title: 'Projects' });
    assert.equal(verdict.pass, prefixCase.pass);
  });
}
