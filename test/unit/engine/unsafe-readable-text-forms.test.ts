// How each readable form of plan 1.3 reads into plain JSON: the exact fields the reader gives for
// the statements the spec prints, one text per JSON value, and the cases the reader passes on to
// the one plan parser to refuse. The texts are the golden texts (golden/readable-unsafe-plans/)
// with one line changed or added, and the spec's own example of a nested locator and a multi-line
// inline check.
// See docs/specs/SPEC-28-plan-authoring.md ("Readable syntax for plan 1.3").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { admitDraft, unverified, writePlanText, type DraftError, type PlanDraft } from '@revisum/engine';
import { memoryEventSink } from './approval-repositories.ts';
import { joinLines, lineOf, linesOf, withLineInserted, withLineReplaced } from './readable-plan-examples.ts';
import { CART_COUNT_CHECK, INLINE_READ, css } from './unsafe-feature-steps.ts';
import {
  OPEN_CART, parseAll, parsedWith, planFromText, readingOf, smallUnsafePlan, unsafeGoldenText, type JsonRecord, type ParsePlan,
} from './unsafe-readable-examples.ts';

const NESTED_CLICK_LINE = 'Unsafe: Click css "button" containing text "Add" inside 2nd css "li.product"';
const INLINE_RUN_LINE = 'Unsafe: Run inline read page script returning blockCount at "/blocks" remembering field blockCount as blockCount:';
const NAMED_RUN_LINE = 'Unsafe: Run page script readCart with currency "eur" remembering field itemCount as cartCount';

// The steps of the JSON a text reads to.
const stepsOf = (text: string, label: string): JsonRecord[] => (readingOf(text, label).json as { steps: JsonRecord[] }).steps;
const cleanupOf = (text: string, label: string): JsonRecord[] => (readingOf(text, label).json as { cleanup: JsonRecord[] }).cleanup;

// The golden text of `feature` with the line holding `statement` replaced by `replacement`.
function changedGolden(feature: Parameters<typeof unsafeGoldenText>[0], statement: string, replacement: string | readonly string[]): string {
  const text = unsafeGoldenText(feature);
  const line = lineOf(text, statement);
  const lines = typeof replacement === 'string' ? [replacement] : replacement;
  const replaced = withLineReplaced(text, line, lines[0] ?? '');
  return lines.slice(1).reduce((current, extra, index) => withLineInserted(current, line + index + 1, extra), replaced);
}

// The inline golden text with its statement and script lines replaced.
const inlineText = (statement: string, scriptLines: readonly string[]): string => {
  const text = unsafeGoldenText('inline-page-script');
  const lines = linesOf(text);
  const start = lines.indexOf(INLINE_RUN_LINE);
  assert.ok(start >= 0, 'the inline golden text has no Run line');
  return joinLines([...lines.slice(0, start), statement, ...scriptLines, ...lines.slice(start + 2)]);
};

function textDraft(content: string): PlanDraft {
  return { format: 'text', content, provenance: { source: 'hand-written', basis: 'declared' } };
}
const actor = () => unverified({ kind: 'plan', hash: 'unsafe-readable-text-forms' }, 'local');

function parserErrors(text: string, parsePlan: ParsePlan = parseAll): readonly DraftError[] {
  const admitted = admitDraft(textDraft(text), parsePlan, memoryEventSink(), actor());
  if (admitted.ok) assert.fail(`the draft was admitted:\n${text}`);
  return admitted.error;
}

// The parser errors as "code path line".
const placed = (errors: readonly DraftError[]): string[] =>
  errors.map((error) => `${error.code} ${error.stage === 'plan' ? error.path : error.stage} ${error.position?.line ?? 'none'}`);

// ---- The spec's example ------------------------------------------------------------------------------

test('the spec\'s example of a nested locator and a multi-line inline check reads to the JSON it describes', { criterion: 'AC-SPEC-28-01' }, () => {
  const text = joinLines([
    ...linesOf(unsafeGoldenText('css-locator')).slice(0, 6),
    'Unsafe: Click css "button" containing text "Add" inside 2nd css "li.product"',
    'Criterion: orders.rows-counted',
    'Unsafe: Expect inline read page script returning count at "/count" field count is number 2:',
    '  "() => {"',
    '  "\\tconst rows = document.querySelectorAll(\\"tr.order\\");"',
    '  "  return { count: rows.length };"',
    '  "}"',
    '',
  ]);
  const steps = stepsOf(text, 'the spec example');
  assert.deepEqual(steps.slice(1), [
    { type: 'click', locator: { by: 'css', selector: 'button', hasText: 'Add', inside: { by: 'css', selector: 'li.product', position: 2 } } },
    {
      type: 'expectScript',
      script: { inline: { source: '() => {\n\tconst rows = document.querySelectorAll("tr.order");\n  return { count: rows.length };\n}', effect: 'read', fields: { count: '/count' } } },
      arguments: {}, field: 'count', assert: { kind: 'numberEquals', value: 2 }, criterionId: 'orders.rows-counted',
    },
  ]);
});

// ---- Locators ------------------------------------------------------------------------------------------

test('an inside chain reads one way: each inside holds the whole rest of the locator', { criterion: 'AC-SPEC-28-01' }, () => {
  const text = changedGolden('css-locator', NESTED_CLICK_LINE, 'Unsafe: Click css "a" inside css "b" inside css "c"');
  assert.deepEqual(stepsOf(text, 'the chain')[2]?.['locator'], {
    by: 'css', selector: 'a', inside: { by: 'css', selector: 'b', inside: { by: 'css', selector: 'c' } },
  });
});

test('a locator\'s containing text comes before its inside, so a later one belongs to the inner locator', { criterion: 'AC-SPEC-28-01' }, () => {
  const text = changedGolden('css-locator', NESTED_CLICK_LINE, 'Unsafe: Click last xpath "//li" inside css "ul" containing text "Cart"');
  assert.deepEqual(stepsOf(text, 'the inner text')[2]?.['locator'], {
    by: 'xpath', expression: '//li', position: 'last', inside: { by: 'css', selector: 'ul', hasText: 'Cart' },
  });
});

test('a selector keeps quotes, backslashes, "#", commas, colons and grammar words exactly', { criterion: 'AC-SPEC-28-01' }, () => {
  const text = changedGolden('css-locator', NESTED_CLICK_LINE, 'Unsafe: Click css "a[title=\\"x \\\\ y\\"]#main:hover, li inside css \\"b\\" is visible"');
  assert.deepEqual(stepsOf(text, 'the awkward selector')[2]?.['locator'], { by: 'css', selector: 'a[title="x \\ y"]#main:hover, li inside css "b" is visible' });
});

test('a value reference in a selector reads as one, and the parser refuses it with wrong_type on its line', { criterion: 'AC-SPEC-28-05' }, () => {
  const text = changedGolden('css-locator', NESTED_CLICK_LINE, 'Unsafe: Click css {orderId}');
  assert.deepEqual(stepsOf(text, 'the reference')[2]?.['locator'], { by: 'css', selector: { valueName: 'orderId' } });
  assert.ok(placed(parserErrors(text)).includes(`wrong_type $.steps[2].locator.selector ${lineOf(text, 'Unsafe: Click css {orderId}')}`), placed(parserErrors(text)).join('\n'));
});

test('a fourth inside reads, and the parser refuses it with too_large on its line', { criterion: 'AC-SPEC-28-05' }, () => {
  const statement = 'Unsafe: Click css "a" inside css "b" inside css "c" inside css "d" inside css "e"';
  const text = changedGolden('css-locator', NESTED_CLICK_LINE, statement);
  assert.deepEqual(placed(parserErrors(text)), [`too_large $.steps[2].locator.inside.inside.inside.inside ${lineOf(text, statement)}`]);
});

test('three insides read and parse, so the fourth is what the parser refuses', { criterion: 'AC-SPEC-28-05' }, () => {
  // The counter-example for too_large.
  const text = changedGolden('css-locator', NESTED_CLICK_LINE, 'Unsafe: Click css "a" inside css "b" inside css "c" inside css "d"');
  assert.doesNotThrow(() => planFromText(text, 'three insides'));
});

// ---- DOM checks ------------------------------------------------------------------------------------------

test('"attribute x is absent" and "attribute x is \\"absent\\"" read as two different checks', { criterion: 'AC-SPEC-28-01' }, () => {
  const absent = 'Unsafe: Expect button "Check out" attribute disabled is absent';
  const steps = stepsOf(changedGolden('dom-checks', absent, [absent, 'Unsafe: Expect button "Check out" attribute disabled is "absent"']), 'absent');
  assert.deepEqual(steps[5]?.['assert'], { kind: 'attributeAbsent', name: 'disabled' });
  assert.deepEqual(steps[6]?.['assert'], { kind: 'attributeEquals', name: 'disabled', value: 'absent' });
});

test('a class name is quoted text, so quotes, braces and commas in it read exactly', { criterion: 'AC-SPEC-28-01' }, () => {
  const line = 'Unsafe: Expect test id "cart-badge" has class "is-active"';
  const steps = stepsOf(changedGolden('dom-checks', line, 'Unsafe: Expect test id "cart-badge" has class "is-\\"on\\",{x}"'), 'class');
  assert.deepEqual(steps[1]?.['assert'], { kind: 'hasClass', value: 'is-"on",{x}' });
});

// ---- Page scripts and database commands -------------------------------------------------------------------

test('a named script without "with" reads with empty arguments, and without "remembering" with no remember field', { criterion: 'AC-SPEC-28-01' }, () => {
  const steps = stepsOf(changedGolden('page-script', NAMED_RUN_LINE, 'Unsafe: Run page script clearEditor'), 'bare run');
  assert.deepEqual(steps[1], { type: 'evaluate', script: 'clearEditor', arguments: {} });
});

test('"remembering nothing" reads as an empty remember field', { criterion: 'AC-SPEC-28-01' }, () => {
  const steps = stepsOf(changedGolden('page-script', NAMED_RUN_LINE, 'Unsafe: Run page script readCart with currency "eur" remembering nothing'), 'nothing');
  assert.deepEqual(steps[1], { type: 'evaluate', script: 'readCart', arguments: { currency: 'eur' }, remember: {} });
});

test('an inline script without "returning" leaves fields out, and "returning nothing" reads as empty fields', { criterion: 'AC-SPEC-28-01' }, () => {
  const without = stepsOf(inlineText('Unsafe: Run inline write page script:', ['  "() => null"']), 'without returning');
  assert.deepEqual(without[1], { type: 'evaluate', script: { inline: { source: '() => null', effect: 'write' } }, arguments: {} });
  const nothing = stepsOf(inlineText('Unsafe: Run inline read page script returning nothing:', ['  "() => null"']), 'returning nothing');
  assert.deepEqual(nothing[1], { type: 'evaluate', script: { inline: { source: '() => null', effect: 'read', fields: {} } }, arguments: {} });
});

test('a returned field at "" points at the whole result', { criterion: 'AC-SPEC-28-01' }, () => {
  const steps = stepsOf(inlineText('Unsafe: Run inline read page script returning whole at "", count at "/count":', ['  "() => 1"']), 'whole');
  assert.deepEqual(steps[1]?.['script'], { inline: { source: '() => 1', effect: 'read', fields: { whole: '', count: '/count' } } });
});

for (const [words, assertion] of [
  ['is present', { kind: 'present' }],
  ['is absent', { kind: 'absent' }],
  ['is "3"', { kind: 'equals', value: '3' }],
  ['contains "3"', { kind: 'contains', value: '3' }],
  ['is number -0.5', { kind: 'numberEquals', value: -0.5 }],
] as const) {
  test(`a script check "field itemCount ${words}" reads as its field check`, { criterion: 'AC-SPEC-28-01' }, () => {
    const line = 'Unsafe: Expect page script readCart with currency "eur" field itemCount is "3"';
    const steps = stepsOf(changedGolden('page-script', line, `Unsafe: Expect page script readCart with currency "eur" field itemCount ${words}`), words);
    assert.deepEqual(steps[2]?.['assert'], assertion);
  });
}

test('a database command check and a database command in Clean up: read as the spec gives them', { criterion: 'AC-SPEC-28-01' }, () => {
  const text = unsafeGoldenText('database-command');
  assert.deepEqual(stepsOf(text, 'database')[2], {
    type: 'expectDatabase', command: 'countOrders', arguments: { email: 'ada@example.com' }, field: 'count', assert: { kind: 'equals', value: '3' },
    criterionId: 'orders.three-seeded',
  });
  assert.deepEqual(cleanupOf(text, 'database'), [{ type: 'database', command: 'seedOrders', arguments: { count: 3 } }]);
});

test('a secret argument reads like any other, and the parser refuses it with wrong_type on its line', { criterion: 'AC-SPEC-28-05' }, () => {
  const statement = 'Unsafe: Run page script readCart with currency secret SHOP_DATABASE_PASSWORD';
  const text = changedGolden('page-script', NAMED_RUN_LINE, statement);
  assert.deepEqual(stepsOf(text, 'secret')[1]?.['arguments'], { currency: { secretName: 'SHOP_DATABASE_PASSWORD' } });
  assert.ok(placed(parserErrors(text)).includes(`wrong_type $.steps[1].arguments.currency ${lineOf(text, statement)}`), placed(parserErrors(text)).join('\n'));
});

// ---- Source blocks -----------------------------------------------------------------------------------------

const sourceOf = (text: string): unknown => ((stepsOf(text, 'source')[1]?.['script'] as { inline?: { source?: unknown } } | undefined)?.inline?.source);

test('script lines are joined with LF and nothing is added at the end', { criterion: 'AC-SPEC-28-01' }, () => {
  assert.equal(sourceOf(inlineText(INLINE_RUN_LINE, ['  "a"', '  "b"', '  "c"'])), 'a\nb\nc');
});

test('a last script line "" gives a source ending with a line break, and a "" inside gives an empty line', { criterion: 'AC-SPEC-28-01' }, () => {
  assert.equal(sourceOf(inlineText(INLINE_RUN_LINE, ['  "a"', '  ""', '  "b"', '  ""'])), 'a\n\nb\n');
});

test('a blank text line in a source block adds no script line', { criterion: 'AC-SPEC-28-01' }, () => {
  assert.equal(sourceOf(inlineText(INLINE_RUN_LINE, ['  "a"', '', '  "b"'])), 'a\nb');
});

test('a comment line in a source block is dropped with comment-dropped and adds no script line', { criterion: 'AC-SPEC-28-01' }, () => {
  const text = inlineText(INLINE_RUN_LINE, ['  "a"', '# a note', '  "b"']);
  assert.equal(sourceOf(text), 'a\nb');
  assert.deepEqual(readingOf(text, 'comment').warnings, [{ code: 'comment-dropped', position: { line: lineOf(text, '# a note'), column: 1 } }]);
});

test('\\t and \\r in a script line read as a tab and a carriage return, beside \\" and \\\\', { criterion: 'AC-SPEC-28-01' }, () => {
  assert.equal(sourceOf(inlineText(INLINE_RUN_LINE, ['  "\\tx = \\"a\\\\b\\";\\r"', '  "y"'])), '\tx = "a\\b";\r\ny');
});

test('a script line keeps its leading and trailing spaces, "#" and a final ":"', { criterion: 'AC-SPEC-28-01' }, () => {
  assert.equal(sourceOf(inlineText(INLINE_RUN_LINE, ['  "  # kept  "', '  "label:"'])), '  # kept  \nlabel:');
});

test('a source with CRLF line ends is written with \\r at the end of every script line but the last', { criterion: 'AC-SPEC-28-01' }, () => {
  const plan = parsedWith(parseAll, smallUnsafePlan([OPEN_CART, { ...INLINE_READ, script: { inline: { source: 'a\r\nb\r\nc', effect: 'read', fields: { blockCount: '/blocks' } } } }]), 'CRLF source');
  const lines = linesOf(writePlanText(plan));
  const start = lines.findIndex((line) => line.startsWith('Unsafe: Run inline'));
  assert.deepEqual(lines.slice(start + 1, start + 4), ['  "a\\r"', '  "b\\r"', '  "c"']);
});

test('the writer escapes every quote, backslash, tab and carriage return in a source, and nothing else', { criterion: 'AC-SPEC-28-01' }, () => {
  const source = '\t"é" \\ 🙂 {x} #:\r';
  const plan = parsedWith(parseAll, smallUnsafePlan([OPEN_CART, { ...INLINE_READ, script: { inline: { source, effect: 'read', fields: { blockCount: '/blocks' } } } }]), 'escaped source');
  const lines = linesOf(writePlanText(plan));
  const start = lines.findIndex((line) => line.startsWith('Unsafe: Run inline'));
  assert.equal(lines[start + 1], '  "\\t\\"é\\" \\\\ 🙂 {x} #:\\r"');
});

test('an inline script\'s empty arguments are written as nothing', { criterion: 'AC-SPEC-28-01' }, () => {
  const text = unsafeGoldenText('inline-page-script');
  assert.equal(linesOf(text).some((line) => line.startsWith('Unsafe: Run inline') && line.includes(' with ')), false);
  assert.deepEqual(stepsOf(text, 'inline')[1]?.['arguments'], {});
});

test('a source block with no script lines leaves the source out, and the parser gives missing_field on the statement\'s line', { criterion: 'AC-SPEC-28-05' }, () => {
  const text = inlineText(INLINE_RUN_LINE, []);
  assert.equal(sourceOf(text), undefined);
  assert.deepEqual(placed(parserErrors(text)), [`missing_field $.steps[1].script.inline.source ${lineOf(text, INLINE_RUN_LINE)}`]);
});

test('a single "" is an empty source, which the parser refuses as empty on the script line', { criterion: 'AC-SPEC-28-05' }, () => {
  const text = inlineText(INLINE_RUN_LINE, ['  ""']);
  assert.equal(sourceOf(text), '');
  assert.deepEqual(placed(parserErrors(text)), [`empty $.steps[1].script.inline.source ${lineOf(text, INLINE_RUN_LINE) + 1}`]);
});

// ---- Placement ---------------------------------------------------------------------------------------------

test('a page-script step in Clean up: reads into cleanup, and the parser refuses it with misplaced_step on its line', { criterion: 'AC-SPEC-28-05' }, () => {
  const text = `${unsafeGoldenText('page-script')}Clean up:\n  ${NAMED_RUN_LINE}\n`;
  assert.equal(cleanupOf(text, 'cleanup script')[0]?.['type'], 'evaluate');
  assert.deepEqual(placed(parserErrors(text)), [`misplaced_step $.cleanup[0] ${linesOf(text).length - 1}`]);
});

test('a database step in a frame reads into the frame, and the parser refuses it with misplaced_step on its line', { criterion: 'AC-SPEC-28-05' }, () => {
  // The golden text runs the same command in its steps and in Clean up:; the step is the unindented one.
  const seed = 'Unsafe: Run database command seedOrders with count 3';
  const lines = linesOf(unsafeGoldenText('database-command'));
  const step = lines.indexOf(seed);
  assert.ok(step >= 0, 'the golden text has no database step');
  const text = joinLines([...lines.slice(0, step), 'Unsafe: In frame css "iframe.editor":', `  ${seed}`, ...lines.slice(step + 1)]);
  assert.deepEqual(placed(parserErrors(text)), [`misplaced_step $.steps[1].steps[0] ${lineOf(text, 'Unsafe: In frame css "iframe.editor":') + 1}`]);
});

test('a database step in Clean up: and a page-script check in a frame parse', { criterion: 'AC-SPEC-28-05' }, () => {
  // The counter-example for misplaced_step: the placements the spec allows.
  assert.doesNotThrow(() => planFromText(unsafeGoldenText('database-command'), 'database cleanup'));
  const plan = parsedWith(parseAll, smallUnsafePlan([OPEN_CART, { type: 'frame', locator: css('iframe.editor'), steps: [CART_COUNT_CHECK] }]), 'frame');
  assert.doesNotThrow(() => planFromText(writePlanText(plan), 'frame check'));
});
