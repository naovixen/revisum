// Errors in the readable text of plan 1.3's unsafe constructs. The reader decides the mark from the
// words it read: a line holding an unsafe construct without "Unsafe:" is missing-unsafe-mark, and a
// marked line holding none is unneeded-unsafe-mark, both at column 1. Script lines take two more
// escapes than other quoted text, and nothing else may stand on them. The parser's refusals of an
// unsafe construct (a disabled feature, an older plan version, a line separator in a script) are
// placed on its marked line, and a path under the inline source on the first script line. No error
// echoes a value.
//
// Every text here is a golden text (golden/readable-unsafe-plans/) with one line changed or added.
// See docs/specs/SPEC-28-plan-authoring.md ("Readable syntax for plan 1.3", Build notes).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitDraft, readPlanText, unverified, type DraftError, type PlanDraft } from '@revisum/engine';
import { memoryEventSink } from './approval-repositories.ts';
import { PRIVATE_MARKER, joinLines, lineAt, lineOf, lineStartingWith, linesOf, withLineInserted, withLineReplaced } from './readable-plan-examples.ts';
import { allBut, parserEnabling } from './unsafe-feature-examples.ts';
import { INLINE_READ } from './unsafe-feature-steps.ts';
import {
  FEATURES, OPEN_CART, parseAll, smallUnsafePlan, textErrorsOf, unsafeGoldenPlan, unsafeGoldenText, unsafeLimits,
  type FeatureName, type ParsePlan,
} from './unsafe-readable-examples.ts';

const shown = (errors: readonly DraftError[]): string => JSON.stringify(errors);

// The one text error with `code` on `line`, at a column from `firstColumn` to `lastColumn`. The code
// is a plain string so the new codes can be named before the code union holds them.
function assertTextError(errors: readonly DraftError[], code: string, line: number, firstColumn: number, lastColumn: number): void {
  const found = errors.filter((error) => error.stage === 'text' && error.code === code && error.position.line === line);
  assert.equal(found.length, 1, `expected one ${code} at line ${line}: ${shown(errors)}`);
  const column = found[0]?.position?.column ?? 0;
  assert.ok(column >= firstColumn && column <= lastColumn, `${code} at column ${column}, not within ${firstColumn} to ${lastColumn}`);
}

function assertNoEcho(input: string, errors: readonly DraftError[]): void {
  // The counter-example that makes the check mean something: the value really is in the input.
  assert.ok(input.includes(PRIVATE_MARKER), 'the input does not hold the private marker');
  assert.equal(shown(errors).includes(PRIVATE_MARKER), false, `an error echoes the input: ${shown(errors)}`);
}

const readsCleanly = (text: string): void => {
  const read = readPlanText(text, unsafeLimits());
  assert.equal(read.ok, true, JSON.stringify(read));
};

// The golden text of `feature` with the line holding `statement` replaced.
function replaced(feature: FeatureName, statement: string, replacement: string): { readonly text: string; readonly line: number } {
  const original = unsafeGoldenText(feature);
  const line = lineOf(original, statement);
  return { text: withLineReplaced(original, line, replacement), line };
}

const draft = (content: string): PlanDraft => ({ format: 'text', content, provenance: { source: 'hand-written', basis: 'declared' } });
const actor = () => unverified({ kind: 'plan', hash: 'unsafe-readable-errors' }, 'local');

function admittedErrors(text: string, parsePlan: ParsePlan): readonly DraftError[] {
  const admitted = admitDraft(draft(text), parsePlan, memoryEventSink(), actor());
  if (admitted.ok) assert.fail(`the draft was admitted:\n${text}`);
  return admitted.error;
}

// ---- The mark ------------------------------------------------------------------------------------------

// Lines of the golden texts that hold an unsafe construct, with the mark the spec requires.
const MARKED_LINES: readonly { readonly feature: FeatureName; readonly construct: string; readonly statement: string }[] = [
  { feature: 'css-locator', construct: 'a CSS locator', statement: 'Unsafe: Expect first css "[data-test^=\\"transaction-item-\\"]" is visible' },
  { feature: 'css-locator', construct: 'a CSS locator inside a CSS locator', statement: 'Unsafe: Click css "button" containing text "Add" inside 2nd css "li.product"' },
  { feature: 'xpath-locator', construct: 'an XPath locator', statement: 'Unsafe: Expect xpath "//main//li[2]" has text containing "Total"' },
  { feature: 'dom-checks', construct: 'a class check', statement: 'Unsafe: Expect test id "cart-badge" has class "is-active"' },
  { feature: 'dom-checks', construct: 'a computed style check', statement: 'Unsafe: Expect test id "cart-badge" computed style background-color is "rgb(220, 38, 38)"' },
  { feature: 'dom-checks', construct: 'an absent attribute check', statement: 'Unsafe: Expect button "Check out" attribute disabled is absent' },
  { feature: 'dom-checks', construct: 'remembering an attribute', statement: 'Unsafe: Remember attribute data-order-id of test id "order-row" as orderId' },
  { feature: 'page-script', construct: 'a named page script', statement: 'Unsafe: Run page script readCart with currency "eur" remembering field itemCount as cartCount' },
  { feature: 'page-script', construct: 'a page-script check', statement: 'Unsafe: Expect page script readCart with currency "eur" field itemCount is "3"' },
  {
    feature: 'inline-page-script', construct: 'an inline page script',
    statement: 'Unsafe: Run inline read page script returning blockCount at "/blocks" remembering field blockCount as blockCount:',
  },
  { feature: 'database-command', construct: 'a database check', statement: 'Unsafe: Expect database command countOrders with email "ada@example.com" field count is "3"' },
];

for (const { feature, construct, statement } of MARKED_LINES) {
  test(`a line holding ${construct} without the mark is missing-unsafe-mark at its line and column 1`, { criterion: 'AC-SPEC-28-05' }, () => {
    const { text, line } = replaced(feature, statement, statement.slice('Unsafe: '.length));
    assertTextError(textErrorsOf(text), 'missing-unsafe-mark', line, 1, 1);
  });
}

test('a database command in Clean up: without the mark is missing-unsafe-mark at its line and column 1', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = unsafeGoldenText('database-command');
  const line = linesOf(original).indexOf('  Unsafe: Run database command seedOrders with count 3') + 1;
  assert.ok(line > 0, 'the golden text has no marked line in Clean up:');
  assertTextError(textErrorsOf(withLineReplaced(original, line, '  Run database command seedOrders with count 3')), 'missing-unsafe-mark', line, 1, 1);
});

test('a frame found by CSS without the mark is missing-unsafe-mark at the frame\'s line and column 1', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = unsafeGoldenText('xpath-locator');
  const line = lineOf(original, 'Go to /cart') + 1;
  const text = withLineInserted(withLineInserted(original, line, 'In frame css "iframe.editor":'), line + 1, '  Click button "Save"');
  assertTextError(textErrorsOf(text), 'missing-unsafe-mark', line, 1, 1);
});

test('a missing mark does not echo the selector', { criterion: 'AC-SPEC-28-05' }, () => {
  const { text, line } = replaced('css-locator', MARKED_LINES[0]?.statement ?? '', `Click css "${PRIVATE_MARKER}"`);
  const errors = textErrorsOf(text);
  assertTextError(errors, 'missing-unsafe-mark', line, 1, 1);
  assertNoEcho(text, errors);
});

test('every golden text, marked as the spec prints it, reads without error', { criterion: 'AC-SPEC-28-05' }, () => {
  // The counter-example for missing-unsafe-mark: the same lines with their mark.
  for (const feature of FEATURES) readsCleanly(unsafeGoldenText(feature));
});

const CLOSED_LINES: readonly { readonly name: string; readonly feature: FeatureName; readonly statement: string; readonly indent: string }[] = [
  { name: 'a navigation', feature: 'css-locator', statement: 'Go to /cart', indent: '' },
  { name: 'a test-id check', feature: 'css-locator', statement: 'Expect test id "status" is visible', indent: '' },
];

for (const { name, feature, statement, indent } of CLOSED_LINES) {
  test(`a marked line holding ${name}, and no unsafe construct, is unneeded-unsafe-mark at its line and column 1`, { criterion: 'AC-SPEC-28-05' }, () => {
    const { text, line } = replaced(feature, statement, `${indent}Unsafe: ${statement}`);
    assertTextError(textErrorsOf(text), 'unneeded-unsafe-mark', line, 1, 1);
  });
}

test('a marked frame line found by role is unneeded-unsafe-mark, though its block holds a marked step', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = unsafeGoldenText('xpath-locator');
  const line = lineOf(original, 'Go to /cart') + 1;
  const text = withLineInserted(withLineInserted(original, line, 'Unsafe: In frame region "Editor":'), line + 1, '  Unsafe: Click css "button.save"');
  assertTextError(textErrorsOf(text), 'unneeded-unsafe-mark', line, 1, 1);
});

test('an unmarked frame line found by role holding a marked step reads without error', { criterion: 'AC-SPEC-28-05' }, () => {
  // The counter-example: a frame line is marked for its own locator only.
  const original = unsafeGoldenText('xpath-locator');
  const line = lineOf(original, 'Go to /cart') + 1;
  readsCleanly(withLineInserted(withLineInserted(original, line, 'In frame region "Editor":'), line + 1, '  Unsafe: Click css "button.save"'));
});

test('a marked call in Clean up: is unneeded-unsafe-mark at its line and column 1', { criterion: 'AC-SPEC-28-05' }, () => {
  const original = unsafeGoldenText('database-command');
  const line = linesOf(original).length;
  const text = withLineInserted(original, line, '  Unsafe: Call resetShop');
  assertTextError(textErrorsOf(text), 'unneeded-unsafe-mark', line, 1, 1);
});

// The spec puts the mark on no line but a step line. It does not name the code a marked header,
// Criterion:, Clean up: or value definition gets, so only the refusal and its line are checked.
for (const prefix of ['Version:', 'Criterion:', 'Clean up:']) {
  test(`a marked ${prefix} line is refused with a text error on its line`, { criterion: 'AC-SPEC-28-05' }, () => {
    const original = unsafeGoldenText('database-command');
    const line = prefix === 'Criterion:' ? lineOf(original, 'Criterion: orders.three-seeded') : lineStartingWith(original, prefix);
    const errors = textErrorsOf(withLineReplaced(original, line, `Unsafe: ${lineAt(original, line)}`));
    assert.ok(errors.some((error) => error.stage === 'text' && error.position.line === line), shown(errors));
  });
}

// ---- Script lines ---------------------------------------------------------------------------------------

const INLINE_RUN = 'Unsafe: Run inline read page script returning blockCount at "/blocks" remembering field blockCount as blockCount:';
// The inline golden text with its script lines replaced, and the line number of the first one.
function withScriptLines(scriptLines: readonly string[]): { readonly text: string; readonly first: number } {
  const lines = linesOf(unsafeGoldenText('inline-page-script'));
  const start = lines.indexOf(INLINE_RUN);
  assert.ok(start >= 0, 'the inline golden text has no Run line');
  return { text: joinLines([...lines.slice(0, start + 1), ...scriptLines, ...lines.slice(start + 2)]), first: start + 2 };
}

test('a marked script line is bad-string at the mark, its first character outside the quotes', { criterion: 'AC-SPEC-28-05' }, () => {
  const { text, first } = withScriptLines(['  Unsafe: "() => 1"']);
  assertTextError(textErrorsOf(text), 'bad-string', first, 3, 3);
});

test('a script line with words after its closing quote is bad-string at its first character outside the quotes', { criterion: 'AC-SPEC-28-05' }, () => {
  const scriptLine = `  "() => 1" ${PRIVATE_MARKER}`;
  const { text, first } = withScriptLines([scriptLine]);
  const errors = textErrorsOf(text);
  const closing = scriptLine.indexOf('" ') + 1;
  assertTextError(errors, 'bad-string', first, closing + 1, closing + 2);
  assertNoEcho(text, errors);
});

test('a script line that is not quoted is bad-string at its first character', { criterion: 'AC-SPEC-28-05' }, () => {
  const { text, first } = withScriptLines([`  () => ${PRIVATE_MARKER}`]);
  const errors = textErrorsOf(text);
  assertTextError(errors, 'bad-string', first, 3, 3);
  assertNoEcho(text, errors);
});

test('a line indented deeper inside a source block is bad-indent at its line', { criterion: 'AC-SPEC-28-05' }, () => {
  const { text, first } = withScriptLines(['  "() => {"', '    "return 1;"', '  "}"']);
  const errors = textErrorsOf(text);
  assertTextError(errors, 'bad-indent', first + 1, 1, 5);
  // The source block itself reads: the deeper line is the only error.
  assert.equal(errors.length, 1, shown(errors));
});

for (const escape of ['\\n', '\\u2028', '\\0', '\\x41']) {
  test(`the escape ${escape} in a script line is bad-string, inside the string`, { criterion: 'AC-SPEC-28-05' }, () => {
    const scriptLine = `  "a${escape}b ${PRIVATE_MARKER}"`;
    const { text, first } = withScriptLines([scriptLine]);
    const errors = textErrorsOf(text);
    assertTextError(errors, 'bad-string', first, 3, scriptLine.length);
    assertNoEcho(text, errors);
  });
}

for (const escape of ['\\t', '\\r']) {
  test(`the escape ${escape}, allowed in a script line, is bad-string in a selector`, { criterion: 'AC-SPEC-28-05' }, () => {
    const statement = 'Unsafe: Click css "button" containing text "Add" inside 2nd css "li.product"';
    const replacement = `Unsafe: Click css "button${escape}x" containing text "Add" inside 2nd css "li.product"`;
    const { text, line } = replaced('css-locator', statement, replacement);
    assertTextError(textErrorsOf(text), 'bad-string', line, replacement.indexOf('"') + 1, replacement.indexOf('x"') + 1);
  });

  test(`the escape ${escape} reads in a script line`, { criterion: 'AC-SPEC-28-05' }, () => {
    // The counter-example: the two escapes a script line adds.
    readsCleanly(withScriptLines([`  "a${escape}b"`]).text);
  });
}

// ---- Names given twice ----------------------------------------------------------------------------------

const NAMED_RUN = 'Unsafe: Run page script readCart with currency "eur" remembering field itemCount as cartCount';

function columnsOf(line: string, token: string, occurrence: number): readonly [number, number] {
  let index = -1;
  for (let found = 0; found < occurrence; found += 1) {
    index = line.indexOf(token, index + 1);
    if (index === -1) throw new Error(`"${token}" does not appear ${occurrence} times in: ${line}`);
  }
  return [index + 1, index + token.length];
}

test('a field named twice in one returning list is duplicate-key at the second one', { criterion: 'AC-SPEC-28-05' }, () => {
  const replacement = INLINE_RUN.replace('returning blockCount at "/blocks"', 'returning blockCount at "/blocks", blockCount at "/other"');
  const { text, line } = replaced('inline-page-script', INLINE_RUN, replacement);
  assertTextError(textErrorsOf(text), 'duplicate-key', line, ...columnsOf(replacement, 'blockCount', 2));
});

test('a value remembered twice in one script step is duplicate-key at the second one', { criterion: 'AC-SPEC-28-05' }, () => {
  const replacement = `${NAMED_RUN}, field total as cartCount`;
  const { text, line } = replaced('page-script', NAMED_RUN, replacement);
  const last = replacement.lastIndexOf('cartCount');
  assertTextError(textErrorsOf(text), 'duplicate-key', line, last + 1, last + 'cartCount'.length);
});

test('an argument given twice to one script is duplicate-key at the second one', { criterion: 'AC-SPEC-28-05' }, () => {
  const replacement = NAMED_RUN.replace('with currency "eur"', 'with currency "eur", currency "usd"');
  const { text, line } = replaced('page-script', NAMED_RUN, replacement);
  assertTextError(textErrorsOf(text), 'duplicate-key', line, ...columnsOf(replacement, 'currency', 2));
});

// ---- Parser errors, placed on the marked line --------------------------------------------------------------

const MARK_OR_CLEANUP = /^\s*(Unsafe:|Clean up:)/;

for (const feature of FEATURES) {
  test(`the ${feature} golden text with ${feature} off is refused with unsafe_feature_disabled, each on a marked line`, { criterion: 'AC-SPEC-28-05' }, () => {
    const text = unsafeGoldenText(feature);
    const errors = admittedErrors(text, parserEnabling(allBut(feature)));
    const disabled = errors.filter((error) => error.code === 'unsafe_feature_disabled');
    assert.ok(disabled.length >= 1, shown(errors));
    for (const error of disabled) {
      assert.ok(error.position !== null, shown([error]));
      assert.match(lineAt(text, error.position?.line ?? 0), MARK_OR_CLEANUP, shown([error]));
    }
  });

  test(`the ${feature} golden text with ${feature} off gives the parser's errors for its JSON, code for code and path for path`, { criterion: 'AC-SPEC-28-05' }, () => {
    // Metamorphic: the text route and the JSON route reach the same parser, so they refuse alike.
    const parsePlan = parserEnabling(allBut(feature));
    const fromJson = parsePlan(unsafeGoldenPlan(feature));
    assert.equal(fromJson.ok, false, 'the JSON was accepted');
    const expected = fromJson.ok ? [] : fromJson.error.map((error) => `${error.code} ${error.path}`);
    const fromText = admittedErrors(unsafeGoldenText(feature), parsePlan).map((error) => `${error.code} ${error.stage === 'plan' ? error.path : error.stage}`);
    assert.deepEqual(fromText, expected);
  });

  for (const version of ['1.2', '1.1'] as const) {
    test(`the ${feature} golden text declaring ${version} is refused as the ${version} parser refuses its JSON, on marked lines`, { criterion: 'AC-SPEC-28-05' }, () => {
      const original = unsafeGoldenText(feature);
      const text = withLineReplaced(original, lineStartingWith(original, 'Version:'), `Version: ${version}`);
      const fromJson = parseAll({ ...unsafeGoldenPlan(feature), version });
      assert.equal(fromJson.ok, false, 'the JSON was accepted');
      const expected = fromJson.ok ? [] : fromJson.error.map((error) => `${error.code} ${error.path}`);
      const errors = admittedErrors(text, parseAll);
      assert.deepEqual(errors.map((error) => `${error.code} ${error.stage === 'plan' ? error.path : error.stage}`), expected);
      for (const error of errors) assert.match(lineAt(text, error.position?.line ?? 0), MARK_OR_CLEANUP, shown([error]));
    });
  }
}

// U+2028, U+2029 and U+0085 would show as line breaks in an editor, so the parser refuses them in a
// script source; the reader splits only at LF, so they reach it on one script line.
const LINE_SEPARATORS: readonly { readonly name: string; readonly character: string }[] = [
  { name: 'U+2028', character: ' ' },
  { name: 'U+2029', character: ' ' },
  { name: 'U+0085', character: '\u0085' },
];

const inlineWith = (source: string) => smallUnsafePlan([OPEN_CART, { ...INLINE_READ, script: { inline: { source, effect: 'read', fields: { blockCount: '/blocks' } } } }]);

for (const { name, character } of LINE_SEPARATORS) {
  test(`the parser refuses ${name} in a JSON script source as unsafe_text at the source`, { criterion: 'AC-SPEC-28-05' }, () => {
    const parsed = parseAll(inlineWith(`() => 1${character}`));
    assert.deepEqual(parsed.ok ? [] : parsed.error, [{ code: 'unsafe_text', path: '$.steps[1].script.inline.source' }]);
  });

  test(`${name} in a script line is the parser's unsafe_text, placed on the first script line, without echoing the source`, { criterion: 'AC-SPEC-28-05' }, () => {
    const { text, first } = withScriptLines(['  "() => {"', `  "  return '${PRIVATE_MARKER}${character}';"`, '  "}"']);
    const errors = admittedErrors(text, parseAll);
    assert.deepEqual(errors.map((error) => `${error.stage} ${error.code} ${error.stage === 'plan' ? error.path : ''} ${error.position?.line ?? 'none'}`),
      [`plan unsafe_text $.steps[1].script.inline.source ${first}`]);
    assertNoEcho(text, errors);
  });
}

test('a source holding a tab, LF and a carriage return is accepted, so the separators above are what the parser refuses', { criterion: 'AC-SPEC-28-05' }, () => {
  // The counter-example for the line separators.
  assert.equal(parseAll(inlineWith('() => {\r\n\treturn 1;\n}')).ok, true);
  readsCleanly(withScriptLines(['  "() => {\\r"', '  "\\treturn 1;"', '  "}"']).text);
  assert.equal(admitDraft(draft(withScriptLines(['  "() => {\\r"', '  "\\treturn 1;"', '  "}"']).text), parseAll, memoryEventSink(), actor()).ok, true);
});
