// Errors in readable text. Each gives its code, line and column, and none holds a value from the
// input: a hostile or private text is never echoed back. Text errors come from readPlanText; the
// plan parser's errors, which name a JSON path, are placed back on the line that path came from
// when admitDraft reads a text draft. A check's criterionId maps to its Criterion: line.
//
// Every text here is a golden plan's canonical text, as writePlanText writes it, with one line
// changed, added or removed. The lines are found by the statement the spec says writePlanText
// prints for them (its grammar, and the plan 1.2 addition's table and examples).
//
// Columns follow the build notes: a statement's own error is at column 1, and any other error
// inside the faulty token.
// See docs/specs/SPEC-28-plan-authoring.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  admitDraft, readPlanText, unverified, writePlanText,
  type DraftError, type PlanDraft, type TextErrorCode,
} from '@revisum/engine';
import { memoryEventSink } from './approval-repositories.ts';
import {
  PRIVATE_MARKER, goldenPlan, lineAt, lineOf, lineStartingWith, linesOf, parsedWith, readableLimits, readableParser, signupPlan,
  withLineInserted, withLineRemoved, withLineReplaced,
} from './readable-plan-examples.ts';

const parsePlan = readableParser();
const limits = readableLimits();
const canonicalText = (name: string): string => writePlanText(parsedWith(parsePlan, goldenPlan(name), `the ${name} plan`));
const signupText = (): string => writePlanText(parsedWith(parsePlan, signupPlan(), 'the sign-up plan'));

// The statements writePlanText prints for the sign-up plan's steps, by step index.
const OPEN_PAGE = 'Go to /';
const CREATE_ACCOUNT = 'Click button "Create account"';
const CAPTURE_FORM = 'Capture "form-filled"';
const FIRST_CHECK = 'Expect heading "Create your account" is visible';
const FIRST_CRITERION = 'Criterion: signup.heading-shown';
const STEP_STATEMENTS: readonly (readonly [number, string])[] = [
  [0, OPEN_PAGE],
  [1, FIRST_CHECK],
  [2, 'Expect page title is "Sign up - Fixture"'],
  [3, 'Type "Ada Lovelace" into label "Full name"'],
  [4, 'Type "ada@example.test" into label "Email"'],
  [5, 'Expect label "Email" has value "ada@example.test"'],
  [6, CAPTURE_FORM],
  [7, 'Click checkbox "I agree to the terms"'],
  [8, CREATE_ACCOUNT],
  [9, 'Expect test id "status" has text containing "Welcome"'],
  [10, 'Expect test id "echo" has text containing "Signed up as"'],
  [11, 'Check accessibility as report'],
  [12, 'Capture "signed-up"'],
];

// Statements of the 1.2 golden plans, as the spec's addition prints them.
const DISPLAY_NAME_VALUE = '  displayName is unique text starting "Tester"';
const ORDER_PATH = 'Go to path "orders" / {orderCode} with query tab "items", highlight {orderCode}';
const CREATE_ORDER = 'Call createOrder with customerName "Ada Lovelace", contactEmail "ada@example.com", quantity 2, region "eu", giftWrap false, deliveryDay "2026-11-02" remembering field orderId as orderId';

function textErrors(text: string): readonly DraftError[] {
  const read = readPlanText(text, limits);
  if (read.ok) assert.fail(`the text was accepted:\n${text}`);
  return read.error;
}

const shown = (errors: readonly DraftError[]): string => JSON.stringify(errors);

// The one text error with `code` on `line`, at a column from `firstColumn` to `lastColumn`.
function assertTextError(errors: readonly DraftError[], code: TextErrorCode, line: number, firstColumn: number, lastColumn: number): void {
  const found = errors.flatMap((error) => (error.stage === 'text' && error.code === code && error.position.line === line ? [error] : []));
  assert.equal(found.length, 1, `expected one ${code} at line ${line}: ${shown(errors)}`);
  const column = found[0]?.position.column ?? 0;
  assert.ok(column >= firstColumn && column <= lastColumn, `${code} at column ${column}, not within ${firstColumn} to ${lastColumn}`);
}

// The 1-based columns of the `occurrence`th (1-based) appearance of `token` in `line`, first to last.
function columnsOf(line: string, token: string, occurrence: number): readonly [number, number] {
  let index = -1;
  for (let found = 0; found < occurrence; found += 1) {
    index = line.indexOf(token, index + 1);
    if (index === -1) throw new Error(`"${token}" does not appear ${occurrence} times in: ${line}`);
  }
  return [index + 1, index + token.length];
}

function assertNoEcho(input: string, errors: readonly DraftError[]): void {
  // The counter-example that makes the check mean something: the value really is in the input.
  assert.ok(input.includes(PRIVATE_MARKER), 'the input does not hold the private marker');
  assert.equal(shown(errors).includes(PRIVATE_MARKER), false, `an error echoes the input: ${shown(errors)}`);
}

// Every error, of either stage, gives a line and a column that lie in the text, or just past its end.
function assertPlaced(text: string, errors: readonly DraftError[]): void {
  const lineCount = linesOf(text).length;
  for (const error of errors) {
    const position = error.position;
    assert.ok(position !== null, `an error has no position: ${shown([error])}`);
    assert.ok(Number.isInteger(position.line) && position.line >= 1 && position.line <= lineCount + 1, `line out of range: ${shown([error])}`);
    assert.ok(Number.isInteger(position.column) && position.column >= 1 && position.column <= lineAt(text, position.line).length + 1,
      `column out of range: ${shown([error])}`);
  }
}

// ---- The unchanged text -------------------------------------------------------------------------------

test('the sign-up plan\'s canonical text reads with no error and no warning', { criterion: 'AC-SPEC-28-05' }, () => {
  const read = readPlanText(signupText(), limits);
  assert.equal(read.ok, true, JSON.stringify(read));
  if (read.ok) assert.deepEqual(read.value.warnings, []);
});

test('reading text gives the line each step came from', { criterion: 'AC-SPEC-28-05' }, () => {
  const text = signupText();
  const read = readPlanText(text, limits);
  if (!read.ok) assert.fail(shown(read.error));
  for (const [index, statement] of STEP_STATEMENTS) {
    assert.equal(read.value.positions.get(`$.steps[${index}]`)?.line, lineOf(text, statement), `the line of step ${index}`);
  }
});

// ---- Statements and placement ---------------------------------------------------------------------------

test('an unknown statement is unknown-statement at its line and column 1, without echoing it', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CAPTURE_FORM);
  const text = withLineReplaced(original, line, `Teleport to "${PRIVATE_MARKER}"`);
  const errors = textErrors(text);
  assertTextError(errors, 'unknown-statement', line, 1, 1);
  assertNoEcho(text, errors);
  assertPlaced(text, errors);
});

test('a header after the first step is unknown-statement at its line and column 1', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const targets = lineStartingWith(original, 'Targets:');
  const moved = withLineRemoved(original, targets);
  const line = lineOf(moved, OPEN_PAGE) + 1;
  const errors = textErrors(withLineInserted(moved, line, lineAt(original, targets)));
  assertTextError(errors, 'unknown-statement', line, 1, 1);
});

test('a statement after the Clean up: block is unknown-statement at its line and column 1', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = canonicalText('order-backend-state');
  assert.ok(original.endsWith('\n'), 'canonical text ends with a newline');
  // Just before the empty line after the final newline: a new last line.
  const line = linesOf(original).length;
  const errors = textErrors(withLineInserted(original, line, 'Click button "Confirm order"'));
  assertTextError(errors, 'unknown-statement', line, 1, 1);
});

// ---- Locators and strings ---------------------------------------------------------------------------------

test('a locator with an unknown role is bad-locator at its line, at the role', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CREATE_ACCOUNT);
  const replacement = `Click banana "${PRIVATE_MARKER}"`;
  const text = withLineReplaced(original, line, replacement);
  const errors = textErrors(text);
  assertTextError(errors, 'bad-locator', line, ...columnsOf(replacement, 'banana', 1));
  assertNoEcho(text, errors);
});

test('a position with the wrong English suffix is bad-locator at its line, at the position', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CREATE_ACCOUNT);
  const replacement = 'Click 2th button "Create account"';
  const errors = textErrors(withLineReplaced(original, line, replacement));
  assertTextError(errors, 'bad-locator', line, ...columnsOf(replacement, '2th', 1));
});

test('the same position with its English suffix reads as position 2', { criterion: 'AC-SPEC-28-05' }, () => {
  // The counter-example for the wrong suffix.
  const original = signupText();
  const read = readPlanText(withLineReplaced(original, lineOf(original, CREATE_ACCOUNT), 'Click 2nd button "Create account"'), limits);
  if (!read.ok) assert.fail(shown(read.error));
  const steps = (read.value.json as { steps: { locator?: unknown }[] }).steps;
  assert.deepEqual(steps[8]?.locator, { by: 'role', role: 'button', name: 'Create account', position: 2 });
});

test('a string with no closing quote is bad-string at its line, from its opening quote on', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CREATE_ACCOUNT);
  const replacement = `Click button "${PRIVATE_MARKER}`;
  const text = withLineReplaced(original, line, replacement);
  const errors = textErrors(text);
  assertTextError(errors, 'bad-string', line, 'Click button '.length + 1, replacement.length + 1);
  assertNoEcho(text, errors);
});

test('a string with an escape other than \\" and \\\\ is bad-string at its line, inside the string', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CREATE_ACCOUNT);
  const replacement = `Click button "Create \\q ${PRIVATE_MARKER}"`;
  const text = withLineReplaced(original, line, replacement);
  const errors = textErrors(text);
  assertTextError(errors, 'bad-string', line, 'Click button '.length + 1, replacement.length);
  assertNoEcho(text, errors);
});

test('a malformed value reference is bad-string at its line, inside the reference', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CREATE_ACCOUNT);
  const replacement = `Click button {${PRIVATE_MARKER} name}`;
  const text = withLineReplaced(original, line, replacement);
  const errors = textErrors(text);
  assertTextError(errors, 'bad-string', line, 'Click button '.length + 1, replacement.length);
  assertNoEcho(text, errors);
});

test('quoted text with the two allowed escapes and braces reads as literal text', { criterion: 'AC-SPEC-28-05' }, () => {
  // The counter-example for the bad-string cases: "{name}" inside quotes is text, not a reference.
  const original = signupText();
  const text = withLineReplaced(original, lineOf(original, CREATE_ACCOUNT), 'Click button "Create \\"new\\" \\\\ {account}"');
  const read = readPlanText(text, limits);
  if (!read.ok) assert.fail(shown(read.error));
  const steps = (read.value.json as { steps: { locator?: unknown }[] }).steps;
  assert.deepEqual(steps[8]?.locator, { by: 'role', role: 'button', name: 'Create "new" \\ {account}' });
});

// ---- Indentation and headers --------------------------------------------------------------------------------

test('a line indented by three spaces outside any block is bad-indent at its line, inside the indentation', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CREATE_ACCOUNT) + 1;
  const errors = textErrors(withLineInserted(original, line, `   ${CREATE_ACCOUNT}`));
  assertTextError(errors, 'bad-indent', line, 1, 4);
});

test('a line indented by a tab is bad-indent at its line and column 1', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CREATE_ACCOUNT);
  const errors = textErrors(withLineReplaced(original, line, `\t${CREATE_ACCOUNT}`));
  assertTextError(errors, 'bad-indent', line, 1, 1);
});

for (const header of ['Plan:', 'Version:', 'Targets:']) {
  test(`text without its ${header} header is missing-header`, { criterion: 'AC-SPEC-28-05' }, () => {
    const original = signupText();
    const text = withLineRemoved(original, lineStartingWith(original, header));
    const errors = textErrors(text);
    assert.ok(errors.some((error) => error.stage === 'text' && error.code === 'missing-header'), shown(errors));
    assertPlaced(text, errors);
  });
}

test('a second Version: header is duplicate-header at the second one\'s line and column 1', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineStartingWith(original, 'Version:');
  const errors = textErrors(withLineInserted(original, line + 1, lineAt(original, line)));
  assertTextError(errors, 'duplicate-header', line + 1, 1, 1);
});

test('an Expect line with no Criterion: header before it is no-criterion at the Expect line and column 1', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const text = withLineRemoved(original, lineOf(original, FIRST_CRITERION));
  const errors = textErrors(text);
  assertTextError(errors, 'no-criterion', lineOf(text, FIRST_CHECK), 1, 1);
});

// ---- Keys and names ---------------------------------------------------------------------------------------------

test('a press of a key the language does not name is unknown-key-name at its line, at the key', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CREATE_ACCOUNT);
  const replacement = 'Press Hyperkey in button "Create account"';
  const errors = textErrors(withLineReplaced(original, line, replacement));
  assertTextError(errors, 'unknown-key-name', line, ...columnsOf(replacement, 'Hyperkey', 1));
});

test('the same press with a key the language names reads without error', { criterion: 'AC-SPEC-28-05' }, () => {
  // The counter-example for unknown-key-name.
  const original = signupText();
  const read = readPlanText(withLineReplaced(original, lineOf(original, CREATE_ACCOUNT), 'Press Enter in button "Create account"'), limits);
  assert.equal(read.ok, true, JSON.stringify(read));
});

test('a value defined twice under Values: is duplicate-key at the second one', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = canonicalText('unique-sign-up');
  const line = lineOf(original, DISPLAY_NAME_VALUE.trim()) + 1;
  const errors = textErrors(withLineInserted(original, line, DISPLAY_NAME_VALUE));
  assertTextError(errors, 'duplicate-key', line, ...columnsOf(DISPLAY_NAME_VALUE, 'displayName', 1));
});

const DUPLICATE_KEYS: readonly { readonly name: string; readonly plan: string; readonly from: string; readonly to: string; readonly key: string }[] = [
  {
    name: 'an argument given twice in one call',
    plan: 'order-backend-state', from: CREATE_ORDER, to: CREATE_ORDER.replace('contactEmail "ada@example.com"', 'customerName "Grace Hopper"'),
    key: 'customerName',
  },
  {
    name: 'a query key given twice in one path template',
    plan: 'order-page-by-path', from: ORDER_PATH, to: ORDER_PATH.replace('highlight {orderCode}', 'tab {orderCode}'),
    key: 'tab',
  },
];

for (const { name, plan, from, to, key } of DUPLICATE_KEYS) {
  test(`${name} is duplicate-key at the second one`, { criterion: 'AC-SPEC-28-05' }, () => {
    const original = canonicalText(plan);
    const line = lineOf(original, from);
    const errors = textErrors(withLineReplaced(original, line, to));
    assertTextError(errors, 'duplicate-key', line, ...columnsOf(to, key, 2));
  });
}

test('a value remembered twice in one call\'s remembering list is duplicate-key at the second one', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = canonicalText('order-backend-state');
  const line = lineOf(original, CREATE_ORDER);
  const to = `${CREATE_ORDER}, field status as orderId`;
  const errors = textErrors(withLineReplaced(original, line, to));
  const last = to.lastIndexOf('orderId');
  assertTextError(errors, 'duplicate-key', line, last + 1, last + 'orderId'.length);
});

test('a name reused elsewhere in the plan is the parser\'s duplicate, not duplicate-key', { criterion: 'AC-SPEC-28-05' }, () => {
  // The counter-example: a Remember naming a value the Values: block defines.
  const original = canonicalText('unique-sign-up');
  const line = linesOf(original).length;
  const text = withLineInserted(original, line, 'Remember text of test id "echo" as contact');
  const read = readPlanText(text, limits);
  if (!read.ok) assert.fail(`the text was refused: ${shown(read.error)}`);
  const admitted = admitDraft(textDraft(text), parsePlan, memoryEventSink(), actor());
  if (admitted.ok) assert.fail('the plan with a reused name was admitted');
  assert.ok(admitted.error.some((error) => error.stage === 'plan' && error.code === 'duplicate'), shown(admitted.error));
});

test('text over the plan size limit is refused with one too-large error, without echoing it', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const long = `${PRIVATE_MARKER} `.repeat(Math.ceil(limits.maximumPlanBytes / PRIVATE_MARKER.length));
  const text = withLineReplaced(original, lineOf(original, CREATE_ACCOUNT), `Click button "${long}"`);
  const errors = textErrors(text);
  assert.deepEqual(errors.map((error) => `${error.stage} ${error.code}`), ['text too-large']);
  assertNoEcho(text, errors);
  assertPlaced(text, errors);
});

// ---- Parser errors, placed back on their line --------------------------------------------------------

function textDraft(content: string): PlanDraft {
  return { format: 'text', content, provenance: { source: 'hand-written', basis: 'declared' } };
}
function actor() {
  return unverified({ kind: 'plan', hash: 'readable-plan-errors' }, 'local');
}

function parserErrors(text: string): readonly DraftError[] {
  const admitted = admitDraft(textDraft(text), parsePlan, memoryEventSink(), actor());
  if (admitted.ok) assert.fail(`the draft was admitted:\n${text}`);
  return admitted.error;
}

// The one parser error at `path`, with `code` unless it is null, placed on `line`.
function assertParserError(errors: readonly DraftError[], code: string | null, path: string, line: number): void {
  const found = errors.flatMap((error) => (error.stage === 'plan' && (code === null || error.code === code) && error.path === path ? [error] : []));
  assert.equal(found.length, 1, `expected one ${code ?? 'error'} at ${path}: ${shown(errors)}`);
  assert.equal(found[0]?.position?.line, line, `${code ?? 'the error'} at ${path} is not placed on line ${line}: ${shown(errors)}`);
}

test('script-like text in a locator is the parser\'s unsafe_text, placed on the step\'s line, without echoing it', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CREATE_ACCOUNT);
  const text = withLineReplaced(original, line, `Click button "<script>${PRIVATE_MARKER}</script>"`);
  const errors = parserErrors(text);
  assertParserError(errors, 'unsafe_text', '$.steps[8].locator.name', line);
  assertNoEcho(text, errors);
  assertPlaced(text, errors);
});

test('a lone surrogate in quoted text is the parser\'s unsafe_text, placed on the step\'s line', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, CREATE_ACCOUNT);
  const errors = parserErrors(withLineReplaced(original, line, 'Click button "Create \uD800 account"'));
  assertParserError(errors, 'unsafe_text', '$.steps[8].locator.name', line);
});

test('the parser refuses a lone surrogate in JSON as unsafe_text, and accepts a whole surrogate pair', { criterion: 'AC-SPEC-28-05' }, () => {
  const named = (name: string) => {
    const plan = signupPlan();
    const steps = plan['steps'] as { locator: { name: string } }[];
    const step = steps[8];
    if (step === undefined) throw new Error('the sign-up plan has no step 8');
    step.locator.name = name;
    return plan;
  };
  for (const lone of ['\uD800', '\uDC00', 'Create \uDBFF']) {
    const parsed = parsePlan(named(lone));
    assert.equal(parsed.ok, false, `a lone surrogate was accepted: ${JSON.stringify(lone)}`);
    if (!parsed.ok) assert.deepEqual(parsed.error, [{ code: 'unsafe_text', path: '$.steps[8].locator.name' }]);
  }
  // The counter-example: the pair that makes one emoji.
  assert.equal(parsePlan(named('Create 🙂 account')).ok, true);
});

test('a target off the matrix is the parser\'s target_not_in_matrix, placed on the Targets: line', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineStartingWith(original, 'Targets:');
  const text = withLineReplaced(original, line, `Targets: ${PRIVATE_MARKER}`);
  const errors = parserErrors(text);
  assertParserError(errors, 'target_not_in_matrix', '$.targets[0]', line);
  assertNoEcho(text, errors);
});

test('a navigation to an origin off the allow-list is the parser\'s origin_not_allowed, placed on the Go to line', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, OPEN_PAGE);
  const text = withLineReplaced(original, line, `Go to https://${PRIVATE_MARKER}.example/`);
  const errors = parserErrors(text);
  assertParserError(errors, 'origin_not_allowed', '$.steps[0].url', line);
  assertNoEcho(text, errors);
});

test('a malformed criterion id is the parser\'s error at the check\'s criterionId, placed on its Criterion: line', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = signupText();
  const line = lineOf(original, FIRST_CRITERION);
  const text = withLineReplaced(original, line, `Criterion: ${PRIVATE_MARKER}!`);
  const errors = parserErrors(text);
  assertParserError(errors, null, '$.steps[1].criterionId', line);
  assertNoEcho(text, errors);
});

test('the unchanged sign-up text is admitted, so the parser errors above come from the changed lines', { criterion: 'AC-SPEC-28-05' }, () => {
  const admitted = admitDraft(textDraft(signupText()), parsePlan, memoryEventSink(), actor());
  assert.equal(admitted.ok, true, JSON.stringify(admitted));
});
