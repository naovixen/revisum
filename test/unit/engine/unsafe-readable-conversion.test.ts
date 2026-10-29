// Conversion between canonical JSON and readable text for plan 1.3's unsafe constructs: every one
// has one readable form on a line marked "Unsafe:", so a plan written as text and read back is the
// same plan, byte for byte in canonical JSON, and writing the text again gives the same text.
//
// The examples are the six 1.3 golden plans, whose text the spec prints exactly
// (golden/readable-unsafe-plans/), and the coverage plans of unsafe-readable-examples.ts, which use
// every unsafe construct and readable form; the property test adds seeded plans whose selectors,
// expressions, class names and script sources are hard to write down. Every plan is parsed with
// all six features enabled.
// See docs/specs/SPEC-28-plan-authoring.md ("Readable syntax for plan 1.3", "Golden plans as text").
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { readPlanText, writePlanJson, writePlanText, type Plan } from '@revisum/engine';
import { joinLines, linesOf } from './readable-plan-examples.ts';
import {
  FEATURES, GOLDEN_TEXT_FOLDER_PATH, UNSAFE_LANGUAGE_FEATURES, UNSAFE_MARK, everyUnsafeExample, generatedUnsafePlans, parseAll, parsedWith,
  planFromText, readingOf, unsafeFeaturesUsed, unsafeGoldenJsonFile, unsafeGoldenPlan, unsafeGoldenText, unsafeLimits, type JsonRecord,
} from './unsafe-readable-examples.ts';

const EXAMPLES = everyUnsafeExample();
const GENERATED_COUNT = 240;
const FIRST_SEED = 2813;

const parsed = (plan: JsonRecord, label: string): Plan => parsedWith(parseAll, plan, label);
const throughText = (plan: Plan, label: string): Plan => planFromText(writePlanText(plan), label);

// ---- The golden plans as text ------------------------------------------------------------------

test('golden/readable-unsafe-plans/ holds the text of each 1.3 golden plan, and nothing else', { criterion: 'AC-SPEC-28-01' }, () => {
  assert.deepEqual(readdirSync(GOLDEN_TEXT_FOLDER_PATH).sort(), FEATURES.map((feature) => `${feature}.plan`).sort());
});

for (const feature of FEATURES) {
  test(`the ${feature} golden plan is written as exactly the text the spec gives`, { criterion: 'AC-SPEC-28-01' }, () => {
    assert.equal(writePlanText(parsed(unsafeGoldenPlan(feature), feature)), unsafeGoldenText(feature));
  });

  test(`the ${feature} golden text reads back to its golden JSON plan, byte for byte in canonical JSON`, { criterion: 'AC-SPEC-28-01' }, () => {
    const fromText = planFromText(unsafeGoldenText(feature), feature);
    const canonical = writePlanJson(parsed(unsafeGoldenPlan(feature), feature));
    assert.equal(writePlanJson(fromText), canonical);
    // The same plan as the golden file holds, field for field.
    assert.deepEqual(JSON.parse(writePlanJson(fromText)), JSON.parse(unsafeGoldenJsonFile(feature)));
  });

  test(`the ${feature} golden text read, parsed and written again is the same text, twice over`, { criterion: 'AC-SPEC-28-02' }, () => {
    const text = unsafeGoldenText(feature);
    const once = writePlanText(planFromText(text, feature));
    const twice = writePlanText(planFromText(once, `${feature} written once`));
    assert.equal(once, text);
    assert.equal(twice, once);
  });

  test(`the ${feature} golden text reads with no error and no warning`, { criterion: 'AC-SPEC-28-02' }, () => {
    const read = readPlanText(unsafeGoldenText(feature), unsafeLimits());
    assert.equal(read.ok, true, JSON.stringify(read));
    if (read.ok) assert.deepEqual(read.value.warnings, []);
  });
}

// ---- What the examples cover ---------------------------------------------------------------------

test('the unsafe conversion examples use every unsafe construct and readable form of plan 1.3', { criterion: 'AC-SPEC-28-01' }, () => {
  const used = new Set<string>();
  for (const { plan } of EXAMPLES) for (const feature of unsafeFeaturesUsed(plan)) used.add(feature);
  assert.deepEqual(UNSAFE_LANGUAGE_FEATURES.filter((feature) => !used.has(feature)), [], 'constructs no example uses');
});

for (const { name, plan } of EXAMPLES) {
  test(`${name} parses with every feature enabled, so the conversion tests start from a valid plan`, { criterion: 'AC-SPEC-28-01' }, () => {
    const result = parseAll(plan);
    assert.equal(result.ok, true, JSON.stringify(result));
  });
}

// ---- JSON to text and back -------------------------------------------------------------------------

for (const { name, plan } of EXAMPLES) {
  test(`${name}: canonical JSON written as text and read back gives byte-identical canonical JSON`, { criterion: 'AC-SPEC-28-01' }, () => {
    const canonical = writePlanJson(parsed(plan, name));
    const fromCanonical = parsed(JSON.parse(canonical), `${name} from canonical JSON`);
    assert.equal(writePlanJson(throughText(fromCanonical, name)), canonical);
  });

  test(`${name}: canonical text read, parsed and written again is the same text, twice over`, { criterion: 'AC-SPEC-28-02' }, () => {
    const text = writePlanText(parsed(plan, name));
    const once = writePlanText(planFromText(text, name));
    assert.equal(once, text);
    assert.equal(writePlanText(planFromText(once, `${name} written once`)), once);
  });

  test(`${name}: canonical text has LF line ends, a final newline and no byte-order mark`, { criterion: 'AC-SPEC-28-02' }, () => {
    const text = writePlanText(parsed(plan, name));
    assert.equal(text.includes('\r'), false, 'canonical text holds a carriage return');
    assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'), 'canonical text does not end with one final newline');
    assert.equal(text.startsWith('﻿'), false, 'canonical text starts with a byte-order mark');
  });
}

// ---- The mark ----------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
const isStructural = (locator: unknown): boolean => isRecord(locator) && (locator['by'] === 'css' || locator['by'] === 'xpath');
const DOM_CHECK_KINDS = ['hasClass', 'lacksClass', 'computedStyleEquals', 'attributeEquals', 'attributeAbsent'];
const UNSAFE_STEPS = ['evaluate', 'expectScript', 'database', 'expectDatabase'];

// Whether a step's own statement holds an unsafe construct: a frame's block is not its own.
function needsMark(step: JsonRecord): boolean {
  const from = step['from'];
  const assertion = step['assert'];
  return isStructural(step['locator'])
    || (isRecord(from) && (from['read'] === 'attribute' || isStructural(from['element'])))
    || (isRecord(assertion) && DOM_CHECK_KINDS.includes(String(assertion['kind'])))
    || UNSAFE_STEPS.includes(String(step['type']));
}
const markedStepCount = (steps: unknown): number => (Array.isArray(steps) ? steps : []).reduce<number>(
  (count, step) => count + (isRecord(step) ? (needsMark(step) ? 1 : 0) + markedStepCount(step['steps']) : 0), 0);

for (const { name, plan } of EXAMPLES) {
  test(`${name}: exactly the lines holding an unsafe construct start with the mark, after their indentation`, { criterion: 'AC-SPEC-28-01' }, () => {
    const text = writePlanText(parsed(plan, name));
    const lines = linesOf(text);
    const marked = lines.filter((line) => line.trimStart().startsWith(UNSAFE_MARK));
    assert.equal(marked.length, markedStepCount(plan['steps']) + markedStepCount(plan['cleanup']), text);
    // The writer prints the mark followed by one space, then a step statement: never a header,
    // Criterion:, Values:, Clean up: or a script line.
    for (const line of marked) assert.match(line.trimStart(), /^Unsafe: (Expect|Click|Hover|Type|In frame|Remember|Run) /, line);
  });
}

// ---- The property test ----------------------------------------------------------------------------

test('seeded plans with awkward selectors and script sources survive the trip through text byte for byte', { criterion: 'AC-SPEC-28-01' }, () => {
  const generated = generatedUnsafePlans(FIRST_SEED, GENERATED_COUNT);
  assert.ok(generated.length >= GENERATED_COUNT * 0.9, `only ${generated.length} of ${GENERATED_COUNT} generated plans parsed`);
  const failures: string[] = [];
  for (const { seed, name, plan } of generated) {
    const canonical = writePlanJson(parsed(plan, `seed ${seed}`));
    const read = readPlanText(writePlanText(parsed(JSON.parse(canonical), `seed ${seed}`)), unsafeLimits());
    if (!read.ok) { failures.push(`seed ${seed} (${name}): the text was refused: ${JSON.stringify(read.error)}`); continue; }
    const again = parseAll(read.value.json);
    if (!again.ok) { failures.push(`seed ${seed} (${name}): the read JSON was refused: ${JSON.stringify(again.error)}`); continue; }
    if (writePlanJson(again.value) !== canonical) failures.push(`seed ${seed} (${name}): the canonical JSON changed`);
  }
  assert.deepEqual(failures, []);
});

test('seeded plans with awkward selectors and script sources keep their canonical text when read and written again', { criterion: 'AC-SPEC-28-02' }, () => {
  const failures: string[] = [];
  for (const { seed, name, plan } of generatedUnsafePlans(FIRST_SEED, GENERATED_COUNT)) {
    const text = writePlanText(parsed(plan, `seed ${seed}`));
    const read = readPlanText(text, unsafeLimits());
    if (!read.ok) { failures.push(`seed ${seed} (${name}): the text was refused: ${JSON.stringify(read.error)}`); continue; }
    const again = parseAll(read.value.json);
    if (!again.ok) { failures.push(`seed ${seed} (${name}): the read JSON was refused: ${JSON.stringify(again.error)}`); continue; }
    if (writePlanText(again.value) !== text) failures.push(`seed ${seed} (${name}): the text changed`);
  }
  assert.deepEqual(failures, []);
});

test('the generated plans really hold the awkward text the property is about', { criterion: 'AC-SPEC-28-01' }, () => {
  // A counter-example guard: if the generator stopped replacing text, the property would pass on
  // the plain examples alone.
  const sources: string[] = [];
  const selectors: string[] = [];
  const collect = (value: unknown, key: string): void => {
    if (typeof value === 'string') {
      if (key === 'source') sources.push(value);
      if (key === 'selector' || key === 'expression') selectors.push(value);
    } else if (Array.isArray(value)) value.forEach((item) => collect(item, ''));
    else if (isRecord(value)) for (const [childKey, child] of Object.entries(value)) collect(child, childKey);
  };
  for (const { plan } of generatedUnsafePlans(FIRST_SEED, GENERATED_COUNT)) collect(plan, '');
  for (const piece of ['\t', '\r\n', '\r', '\n', '"', '\\', '#', 'Unsafe: ', '日本語']) {
    assert.ok(sources.some((source) => source.includes(piece)), `no generated source holds ${JSON.stringify(piece)}`);
  }
  assert.ok(sources.some((source) => source.endsWith('\n')), 'no generated source ends with a line break');
  assert.ok(sources.some((source) => source.startsWith(' ') || source.endsWith(' ')), 'no generated source starts or ends with a space');
  for (const piece of ['"', '\\', ' inside ', ' containing text ', 'Unsafe: ']) {
    assert.ok(selectors.some((selector) => selector.includes(piece)), `no generated selector holds ${JSON.stringify(piece)}`);
  }
});

// ---- Re-layouts that change nothing -----------------------------------------------------------------

const MARKED = /^(\s*)Unsafe:( .*)$/;

const RELAYOUTS: readonly { readonly name: string; readonly relayout: (text: string) => string }[] = [
  { name: 'the mark in lower case', relayout: (text) => joinLines(linesOf(text).map((line) => line.replace(MARKED, '$1unsafe:$2'))) },
  { name: 'the mark in upper case', relayout: (text) => joinLines(linesOf(text).map((line) => line.replace(MARKED, '$1UNSAFE:$2'))) },
  { name: 'three spaces after the mark', relayout: (text) => joinLines(linesOf(text).map((line) => line.replace(MARKED, '$1Unsafe:  $2'))) },
  {
    // Blank lines may stand inside a source block too, and add no script line.
    name: 'a blank line before and after every line',
    relayout: (text) => joinLines(['', ...linesOf(text).flatMap((line) => [line, ''])]),
  },
  {
    // A comment line inside a source block is dropped and adds no script line.
    name: 'a comment line before every line',
    relayout: (text) => joinLines(linesOf(text).flatMap((line) => (line !== '' ? ['# reviewed by the founder', line] : [line]))),
  },
  { name: 'CRLF line ends', relayout: (text) => text.replaceAll('\n', '\r\n') },
  { name: 'a byte-order mark at the start', relayout: (text) => `﻿${text}` },
  { name: 'spaces at the end of every line', relayout: (text) => joinLines(linesOf(text).map((line) => (line === '' ? line : `${line}   `))) },
];

for (const { name, plan } of EXAMPLES) {
  for (const { name: relayoutName, relayout } of RELAYOUTS) {
    test(`${name}: canonical text with ${relayoutName} is written back as the canonical text`, { criterion: 'AC-SPEC-28-02' }, () => {
      const text = writePlanText(parsed(plan, name));
      const relaidOut = relayout(text);
      assert.notEqual(relaidOut, text, 'the re-layout changed nothing, so it proves nothing');
      assert.equal(writePlanText(planFromText(relaidOut, `${name} with ${relayoutName}`)), text);
    });
  }
}

// The new grammar words in another case, on the golden texts. Only words outside quoted text change.
const WORD_CASE_CHANGES: readonly { readonly feature: (typeof FEATURES)[number]; readonly from: string; readonly to: string }[] = [
  { feature: 'css-locator', from: 'Unsafe: Expect first css "', to: 'Unsafe: Expect FIRST CSS "' },
  { feature: 'css-locator', from: '" containing text "Add" inside 2nd css "', to: '" Containing Text "Add" INSIDE 2nd Css "' },
  { feature: 'xpath-locator', from: 'Unsafe: Expect xpath "', to: 'Unsafe: expect XPATH "' },
  { feature: 'dom-checks', from: '" has class "', to: '" HAS CLASS "' },
  { feature: 'dom-checks', from: '" lacks class "', to: '" Lacks Class "' },
  { feature: 'dom-checks', from: '" computed style background-color is "', to: '" COMPUTED STYLE background-color IS "' },
  { feature: 'dom-checks', from: '" attribute disabled is absent', to: '" ATTRIBUTE disabled IS ABSENT' },
  { feature: 'dom-checks', from: 'Unsafe: Remember attribute data-order-id of test id', to: 'Unsafe: REMEMBER ATTRIBUTE data-order-id OF test id' },
  { feature: 'page-script', from: 'Unsafe: Run page script readCart with', to: 'Unsafe: RUN Page Script readCart WITH' },
  { feature: 'page-script', from: '" remembering field itemCount as cartCount', to: '" REMEMBERING FIELD itemCount AS cartCount' },
  { feature: 'inline-page-script', from: 'Unsafe: Run inline read page script returning blockCount at "', to: 'Unsafe: Run INLINE READ PAGE SCRIPT RETURNING blockCount AT "' },
  { feature: 'database-command', from: 'Unsafe: Expect database command countOrders', to: 'Unsafe: Expect DATABASE COMMAND countOrders' },
];

for (const { feature, from, to } of WORD_CASE_CHANGES) {
  test(`the ${feature} golden text with "${to.trim()}" in another case reads as the same plan`, { criterion: 'AC-SPEC-28-02' }, () => {
    const text = unsafeGoldenText(feature);
    assert.ok(text.includes(from), `the golden text has no "${from}"`);
    const changed = text.replace(from, to);
    assert.equal(writePlanText(planFromText(changed, `${feature} with "${to}"`)), text);
  });
}

test('a comment line inside a source block is dropped with comment-dropped and the source keeps its lines', { criterion: 'AC-SPEC-28-02' }, () => {
  const text = unsafeGoldenText('inline-page-script');
  const lines = linesOf(text);
  const scriptLine = lines.findIndex((line) => line.startsWith('  "'));
  assert.ok(scriptLine > 0, 'the inline golden text has no script line');
  const commented = joinLines([...lines.slice(0, scriptLine), '# what the script reads', ...lines.slice(scriptLine)]);
  const reading = readingOf(commented, 'the commented inline text');
  assert.deepEqual(reading.warnings, [{ code: 'comment-dropped', position: { line: scriptLine + 1, column: 1 } }]);
  assert.equal(writePlanText(parsed(reading.json as JsonRecord, 'the commented inline plan')), text);
});
