// Conversion between the two forms of a plan: canonical JSON (writePlanJson) and readable text
// (writePlanText, read back by readPlanText into plain JSON for the one plan parser). The
// conversion is lossless for every field of the language, so a plan written as text and read back
// is the same plan, byte for byte in canonical JSON, and writing the text again gives the same
// text. A re-layout of the text (blank lines, the case of statement words, comment lines, CRLF
// line ends, a byte-order mark, spaces at line ends and between tokens) reads as the same plan.
//
// The examples are every golden plan, 1.1 and 1.2, and the coverage plans of
// readable-plan-examples.ts, which together use every construct of the language and of the
// readable form's plan 1.2 addition; the property test adds seeded plans whose page-facing and
// header text is hard to write down.
// See docs/specs/SPEC-28-plan-authoring.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readPlanText, writePlanJson, writePlanText, type Plan, type TextReading } from '@revisum/engine';
import {
  STATEMENT_WORDS, everyExample, featuresOf, generatedPlans, joinLines, languageFeatures, linesOf, parsedWith, readableLimits,
  readableParser, type JsonRecord,
} from './readable-plan-examples.ts';

const parsePlan = readableParser();
const limits = readableLimits();
const EXAMPLES = everyExample();
// How many seeded plans the property test makes, and how many of them must parse.
const GENERATED_COUNT = 300;
const FIRST_SEED = 2810;

function reading(text: string, label: string): TextReading {
  const read = readPlanText(text, limits);
  if (!read.ok) assert.fail(`${label}: the text was refused: ${JSON.stringify(read.error)}\n${text}`);
  return read.value;
}

// The plan that text reads and parses to.
const planFromText = (text: string, label: string): Plan => parsedWith(parsePlan, reading(text, label).json, `${label} read from text`);
// The plan, written as text and read back.
const throughText = (plan: Plan, label: string): Plan => planFromText(writePlanText(plan), label);

// A deep copy of plain JSON with every object's keys in reverse order.
const keysReversed = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(keysReversed);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value as JsonRecord).reverse().map(([key, child]) => [key, keysReversed(child)]));
  }
  return value;
};

// ---- What the examples cover -----------------------------------------------------------------------

test('the conversion examples use every step type, locator kind, role, assertion kind, key and plan field', { criterion: 'AC-SPEC-28-01' }, () => {
  const used = new Set<string>();
  for (const { plan } of EXAMPLES) for (const feature of featuresOf(plan)) used.add(feature);
  assert.deepEqual(languageFeatures().filter((feature) => !used.has(feature)), [], 'features no conversion example uses');
});

for (const { name, plan } of EXAMPLES) {
  test(`${name} parses, so the conversion tests start from a valid plan`, { criterion: 'AC-SPEC-28-01' }, () => {
    const parsed = parsePlan(plan);
    assert.equal(parsed.ok, true, JSON.stringify(parsed));
  });
}

// ---- Canonical JSON ----------------------------------------------------------------------------------

for (const { name, plan } of EXAMPLES) {
  test(`${name}: canonical JSON is two-space indented, with LF line ends and a final newline, and holds the plan`, { criterion: 'AC-SPEC-28-01' }, () => {
    const parsed = parsedWith(parsePlan, plan, name);
    const canonical = writePlanJson(parsed);
    assert.equal(canonical.includes('\r'), false, 'canonical JSON holds a carriage return');
    assert.ok(canonical.endsWith('}\n'), 'canonical JSON does not end with one final newline');
    assert.equal(canonical, `${JSON.stringify(JSON.parse(canonical), null, 2)}\n`, 'canonical JSON is not two-space indented JSON');
    assert.deepEqual(JSON.parse(canonical), JSON.parse(JSON.stringify(parsed)));
  });

  test(`${name}: canonical JSON does not depend on the key order or layout of the input`, { criterion: 'AC-SPEC-28-01' }, () => {
    const canonical = writePlanJson(parsedWith(parsePlan, plan, name));
    const relaidOut = JSON.parse(JSON.stringify(keysReversed(plan), null, 4));
    assert.equal(writePlanJson(parsedWith(parsePlan, relaidOut, `${name} with its keys reversed`)), canonical);
    assert.equal(writePlanJson(parsedWith(parsePlan, JSON.parse(canonical), `${name} from canonical JSON`)), canonical);
  });
}

// ---- JSON to text and back -------------------------------------------------------------------------

for (const { name, plan } of EXAMPLES) {
  test(`${name}: canonical JSON written as text and read back gives byte-identical canonical JSON`, { criterion: 'AC-SPEC-28-01' }, () => {
    const canonical = writePlanJson(parsedWith(parsePlan, plan, name));
    const fromCanonical = parsedWith(parsePlan, JSON.parse(canonical), `${name} from canonical JSON`);
    assert.equal(writePlanJson(throughText(fromCanonical, name)), canonical);
  });
}

test('seeded plans with awkward page text survive the trip through text byte for byte', { criterion: 'AC-SPEC-28-01' }, () => {
  const generated = generatedPlans(parsePlan, FIRST_SEED, GENERATED_COUNT);
  // The generator keeps only plans the parser accepts; nearly all of them must be kept, or the
  // property is tested on too little.
  assert.ok(generated.length >= GENERATED_COUNT * 0.9, `only ${generated.length} of ${GENERATED_COUNT} generated plans parsed`);
  const failures: string[] = [];
  for (const { seed, name, plan } of generated) {
    const canonical = writePlanJson(parsedWith(parsePlan, plan, `seed ${seed}`));
    const read = readPlanText(writePlanText(parsedWith(parsePlan, JSON.parse(canonical), `seed ${seed}`)), limits);
    if (!read.ok) { failures.push(`seed ${seed} (${name}): the text was refused: ${JSON.stringify(read.error)}`); continue; }
    const parsed = parsePlan(read.value.json);
    if (!parsed.ok) { failures.push(`seed ${seed} (${name}): the read JSON was refused: ${JSON.stringify(parsed.error)}`); continue; }
    if (writePlanJson(parsed.value) !== canonical) failures.push(`seed ${seed} (${name}): the canonical JSON changed`);
  }
  assert.deepEqual(failures, []);
});

test('seeded plans with awkward page text keep their canonical text when it is read and written again', { criterion: 'AC-SPEC-28-02' }, () => {
  const failures: string[] = [];
  for (const { seed, name, plan } of generatedPlans(parsePlan, FIRST_SEED, GENERATED_COUNT)) {
    const text = writePlanText(parsedWith(parsePlan, plan, `seed ${seed}`));
    const read = readPlanText(text, limits);
    if (!read.ok) { failures.push(`seed ${seed} (${name}): the text was refused: ${JSON.stringify(read.error)}`); continue; }
    const parsed = parsePlan(read.value.json);
    if (!parsed.ok) { failures.push(`seed ${seed} (${name}): the read JSON was refused: ${JSON.stringify(parsed.error)}`); continue; }
    if (writePlanText(parsed.value) !== text) failures.push(`seed ${seed} (${name}): the text changed`);
  }
  assert.deepEqual(failures, []);
});

test('the generated plans start or end header and page text with spaces and quotes, which the writer must quote', { criterion: 'AC-SPEC-28-01' }, () => {
  // A counter-example guard for the quoting rules: the property is only tested if these occur.
  const metas = generatedPlans(parsePlan, FIRST_SEED, GENERATED_COUNT).map(({ plan }) => plan['meta'] as JsonRecord);
  const headerTexts = metas.flatMap((meta) => [String(meta['title']), String(meta['specReference'])]);
  assert.ok(headerTexts.some((value) => value.startsWith(' ') || value.endsWith(' ')), 'no header text starts or ends with a space');
  assert.ok(headerTexts.some((value) => value.startsWith('"')), 'no header text starts with a quote');
});

test('the generated plans really hold the awkward text the property is about', { criterion: 'AC-SPEC-28-01' }, () => {
  // A counter-example guard: if the generator stopped replacing text, the property above would
  // pass on the plain examples alone.
  const generated = generatedPlans(parsePlan, FIRST_SEED, GENERATED_COUNT);
  const allText = generated.map(({ plan }) => JSON.stringify(plan)).join('\n');
  for (const piece of ['\\"', '\\\\', '#', ' is visible', 'Criterion: AC-9', '日本語']) {
    assert.ok(allText.includes(piece), `no generated plan holds ${piece}`);
  }
});

// ---- Text to text ------------------------------------------------------------------------------------

for (const { name, plan } of EXAMPLES) {
  test(`${name}: canonical text read, parsed and written again is the same text, twice over`, { criterion: 'AC-SPEC-28-02' }, () => {
    const canonicalText = writePlanText(parsedWith(parsePlan, plan, name));
    const once = writePlanText(planFromText(canonicalText, name));
    const twice = writePlanText(planFromText(once, `${name} written once`));
    assert.equal(once, canonicalText);
    assert.equal(twice, once);
  });
}

// Re-layouts of canonical text that the grammar says change nothing.
const RELAYOUTS: readonly { readonly name: string; readonly relayout: (text: string) => string }[] = [
  {
    name: 'a blank line before and after every line',
    relayout: (text) => joinLines(['', ...linesOf(text).flatMap((line) => [line, ''])]),
  },
  {
    name: 'statement words in lower and upper case',
    relayout: (text) => joinLines(linesOf(text).map((line, index) => {
      const statement = /^(\s*)(\S+)(.*)$/.exec(line);
      if (statement === null || !STATEMENT_WORDS.includes(statement[2] ?? '')) return line;
      const word = statement[2] ?? '';
      return `${statement[1] ?? ''}${index % 2 === 0 ? word.toLowerCase() : word.toUpperCase()}${statement[3] ?? ''}`;
    })),
  },
  {
    // Comment lines may stand anywhere, inside blocks too, and neither open nor close a block.
    name: 'a comment line before every line',
    relayout: (text) => joinLines(linesOf(text).flatMap((line) => (line !== '' ? ['# reviewed by the founder', line] : [line]))),
  },
  {
    name: 'CRLF line ends',
    relayout: (text) => text.replaceAll('\n', '\r\n'),
  },
  {
    name: 'a byte-order mark at the start',
    relayout: (text) => `﻿${text}`,
  },
  {
    name: 'spaces at the end of every line',
    relayout: (text) => joinLines(linesOf(text).map((line) => (line === '' ? line : `${line}   `))),
  },
  {
    // Outside quoted text the reader accepts several spaces between tokens.
    name: 'three spaces after the first word of every step statement',
    relayout: (text) => joinLines(linesOf(text).map((line) => {
      const statement = /^(\s*)(\S+) (.*)$/.exec(line);
      if (statement === null || !STATEMENT_WORDS.includes(statement[2] ?? '')) return line;
      return `${statement[1] ?? ''}${statement[2] ?? ''}   ${statement[3] ?? ''}`;
    })),
  },
];

for (const { name, plan } of EXAMPLES) {
  test(`${name}: canonical text has LF line ends, a final newline and no byte-order mark`, { criterion: 'AC-SPEC-28-02' }, () => {
    const canonicalText = writePlanText(parsedWith(parsePlan, plan, name));
    assert.equal(canonicalText.includes('\r'), false, 'canonical text holds a carriage return');
    assert.ok(canonicalText.endsWith('\n') && !canonicalText.endsWith('\n\n'), 'canonical text does not end with one final newline');
    assert.equal(canonicalText.startsWith('﻿'), false, 'canonical text starts with a byte-order mark');
  });
}

for (const { name, plan } of EXAMPLES) {
  for (const { name: relayoutName, relayout } of RELAYOUTS) {
    test(`${name}: canonical text with ${relayoutName} is written back as the canonical text`, { criterion: 'AC-SPEC-28-02' }, () => {
      const canonicalText = writePlanText(parsedWith(parsePlan, plan, name));
      const relaidOut = relayout(canonicalText);
      assert.notEqual(relaidOut, canonicalText, 'the re-layout changed nothing, so it proves nothing');
      assert.equal(writePlanText(planFromText(relaidOut, `${name} with ${relayoutName}`)), canonicalText);
    });
  }
}

test('each dropped comment line is reported once, as comment-dropped at its own line and column 1', { criterion: 'AC-SPEC-28-02' }, () => {
  const example = EXAMPLES.find(({ name }) => name === 'golden signup');
  assert.ok(example !== undefined, 'the sign-up golden plan is missing');
  const canonicalText = writePlanText(parsedWith(parsePlan, example.plan, example.name));
  const commented = joinLines(['# first note', ...linesOf(canonicalText).slice(0, 2), '# second note', ...linesOf(canonicalText).slice(2)]);
  const read = reading(commented, 'the commented sign-up text');
  assert.deepEqual(read.warnings, [
    { code: 'comment-dropped', position: { line: 1, column: 1 } },
    { code: 'comment-dropped', position: { line: 4, column: 1 } },
  ]);
  // The counter-example: the same text without its comments warns of nothing.
  assert.deepEqual(reading(canonicalText, 'the sign-up text').warnings, []);
  // A comment is never carried into the JSON.
  assert.equal(JSON.stringify(read.json).includes('note'), false);
});
