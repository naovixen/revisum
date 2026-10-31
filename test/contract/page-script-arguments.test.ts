// A page script receives its arguments as JSON values, never spliced into its source, and its
// source reaches the page unchanged, on both drivers.
//
// The declared script echoArguments (fixtures/unsafe-features-project/plans/scripts/) reports how
// many arguments it was called with, the names of the one object's fields, the text, number and
// boolean it received, and the sha256 of its own source text as the page compiled it. One
// expectScript step per argument set checks that report against the one the test computes from the
// argument set itself and the declared file's bytes.
// The relation checked over 1,000 generated argument sets (quotes, `"); fetch(`, template-literal
// text, backslashes and non-Latin text) is identity: what the script receives is what the plan
// wrote, and the source the page ran is the file, whatever the arguments. The mutant shows a
// driver that spliced the text into the source would fail it: the same sets, spliced, break the
// script or change what it receives.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { after, before, describe, test } from 'node:test';
import { approvedStanding } from '../unit/engine/policy-examples.ts';
import { fakeEnvironmentStore, fakeSecretValue } from '../unit/engine/secret-examples.ts';
import {
  BOTH_TARGETS, ECHO_ARGUMENTS_FILE, ECHO_COUNT_MAXIMUM, ECHO_TEXT_MAXIMUM_LENGTH, PAGE_SECRET, expectScript, fill, inlineScript, label,
  navigate, outcomes, scriptFileText, secretValue, unsafePageHarness, unsafePagePlan, type JsonRecord, type UnsafePageHarness,
} from './unsafe-page-support.ts';

const TIMEOUT = 600_000;
const ARGUMENT_SETS = 1000;
// Kept well under the project's maximumCalls of 200: every expectScript is one script call.
const SETS_PER_RUN = 100;

let harness: UnsafePageHarness;
before(async () => { harness = await unsafePageHarness(); });
after(async () => { await harness.close(); });

type ArgumentSet = { readonly text: string; readonly count: number; readonly flag: boolean };

// ---- Generating argument sets ----------------------------------------------------------------------

// The hostile pieces texts are built from. None holds "<", "=", ":" or "-", so no text can look like
// markup, an event handler, a script URL or a credential, which the plan parser would refuse.
const PIECES: readonly string[] = [
  '"', '\'', '`', '"); fetch(', '\'); fetch(\'/x\')//', '${document.cookie}', '`${alert(1)}`', '${', '}', '\\', '\\"', '\\u0041', '\\n',
  ')', '(', '];', '//', '/*', '*/', ' ', '  ', 'null', 'undefined', '{"a"', '1e3', 'Ada', 'Größe', 'Ελληνικά', 'Привет', 'עברית',
  'العربية', '日本語のテキスト', '中文', '한국어', '🙂', '👩‍💻', 'é', 'café', '£42', '½',
];

// The named cases first, then sets drawn from the pieces by a seeded generator, so a failure names
// the same set on every run.
const NAMED_TEXTS: readonly string[] = [
  'He said "hello" and \'goodbye\'',
  '"); fetch(',
  '\'); fetch(\'/steal\')//',
  '`${document.cookie}`',
  '${alert(1)}',
  'Größe Ελληνικά Привет 日本語 العربية 🙂',
  '\\"); fetch(\\"',
];

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function generatedArgumentSets(total: number): readonly ArgumentSet[] {
  const random = seededRandom(3609);
  const pick = <Value>(choices: readonly Value[]): Value => choices[Math.floor(random() * choices.length)] as Value;
  const sets: ArgumentSet[] = [];
  for (let index = 0; index < total; index++) {
    let text = NAMED_TEXTS[index] ?? Array.from({ length: 2 + Math.floor(random() * 8) }, () => pick(PIECES)).join('');
    // Cut by code point, so no surrogate pair is split.
    text = Array.from(text).slice(0, ECHO_TEXT_MAXIMUM_LENGTH).join('');
    if (text.trim() === '') text = `${text}x`;
    sets.push({ text, count: Math.floor(random() * (ECHO_COUNT_MAXIMUM + 1)), flag: random() < 0.5 });
  }
  return sets;
}

const ALL_SETS = generatedArgumentSets(ARGUMENT_SETS);

// Letters of a script other than Latin, or an emoji.
const NON_LATIN = /\p{Script=Greek}|\p{Script=Cyrillic}|\p{Script=Hebrew}|\p{Script=Arabic}|\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Hangul}|\p{Extended_Pictographic}/u;

// ---- What the script must report -------------------------------------------------------------------

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

// The report echoArguments gives when it was called once, with one object holding exactly the
// declared arguments as the plan wrote them, and its source text was `source`.
const expectedReport = (set: ArgumentSet, source: string): string => JSON.stringify({
  callArguments: 1,
  names: ['count', 'flag', 'text'],
  textType: 'string',
  text: set.text,
  count: set.count,
  flag: set.flag,
  sourceSha256: sha256(source),
});

const echoCheck = (script: unknown, set: ArgumentSet, source: string, index: number): JsonRecord =>
  expectScript(script, { text: set.text, count: set.count, flag: set.flag }, 'report', { kind: 'equals', value: expectedReport(set, source) }, `echo.set-${index}`);

const batches = (sets: readonly ArgumentSet[]): readonly (readonly ArgumentSet[])[] =>
  Array.from({ length: Math.ceil(sets.length / SETS_PER_RUN) }, (_unused, batch) => sets.slice(batch * SETS_PER_RUN, (batch + 1) * SETS_PER_RUN));

test('the declared script file is one function expression with nothing around it, so its bytes are its source text', { criterion: 'AC-SPEC-36-09' }, () => {
  const source = scriptFileText(ECHO_ARGUMENTS_FILE);
  assert.equal(source, source.trim(), 'no leading or trailing whitespace in the fixture file');
  assert.ok(source.startsWith('async function echoArguments('), source.slice(0, 40));
});

test('the generated argument sets hold quotes, "); fetch(, template-literal text and non-Latin text, and almost all differ', { criterion: 'AC-SPEC-36-09' }, () => {
  const texts = ALL_SETS.map((set) => set.text);
  assert.equal(ALL_SETS.length, ARGUMENT_SETS);
  for (const needle of ['"', '\'', '"); fetch(', '${', '`']) assert.ok(texts.filter((text) => text.includes(needle)).length >= 50, `at least 50 sets hold ${needle}`);
  assert.ok(texts.filter((text) => NON_LATIN.test(text)).length >= 100, 'at least 100 sets hold non-Latin text');
  assert.ok(new Set(texts).size > 990, `only ${new Set(texts).size} distinct texts`);
});

// Mutant: a driver that spliced each text into the source, as a string literal, would run code the
// plan wrote or receive other text. Spliced into a sandbox with nothing to reach, the hostile sets
// either break the script or change what it receives, so the browser runs below can tell.
test('mutant: splicing the same texts into the source breaks the script or changes what it receives', { criterion: 'AC-SPEC-36-09' }, () => {
  const changed = ALL_SETS.filter((set) => {
    try {
      const received: unknown = runInNewContext(`((received) => received)("${set.text}")`, { fetch: () => 'fetched', alert: () => 'alerted', document: { cookie: 'c' } }, { timeout: 100 });
      return received !== set.text;
    } catch {
      return true;
    }
  });
  assert.ok(changed.length >= 100, `only ${changed.length} sets would catch a splicing driver`);
  assert.ok(changed.some((set) => set.text === '"); fetch('), 'the named "); fetch( set is among them');
});

for (const targetId of BOTH_TARGETS) {
  describe(`named page script arguments: ${targetId}`, () => {
    test(`each of ${ARGUMENT_SETS} generated argument sets reaches the script as one JSON object, and the page runs the file's exact source`, { criterion: 'AC-SPEC-36-09', timeout: TIMEOUT }, async () => {
      const source = scriptFileText(ECHO_ARGUMENTS_FILE);
      let checked = 0;
      for (const [batch, sets] of batches(ALL_SETS).entries()) {
        const first = batch * SETS_PER_RUN;
        const steps = [navigate('/'), ...sets.map((set, offset) => echoCheck('echoArguments', set, source, first + offset))];
        const ran = await harness.runSteps(targetId, steps);
        const failed = outcomes(ran.result).find(([, outcome]) => outcome !== 'passed');
        assert.equal(failed, undefined, failed === undefined ? '' : `argument set ${first + failed[0] - 1}: ${JSON.stringify(sets[failed[0] - 1])} gave ${JSON.stringify(ran.result.steps[failed[0]])}`);
        assert.equal(ran.result.state, 'Passed');
        checked += sets.length;
      }
      assert.equal(checked, ARGUMENT_SETS);
    });

    // Counter-example: the same check against a report computed for other arguments fails, so a
    // passing check is not one that passes on anything.
    test('counter-example: a report expected for other arguments, or another source, fails the check', { criterion: 'AC-SPEC-36-09', timeout: TIMEOUT }, async () => {
      const [set] = ALL_SETS;
      assert.ok(set !== undefined);
      const source = scriptFileText(ECHO_ARGUMENTS_FILE);
      const otherText = expectScript('echoArguments', { text: set.text, count: set.count, flag: set.flag }, 'report',
        { kind: 'equals', value: expectedReport({ ...set, text: `${set.text} ` }, source) }, 'echo.other-text');
      const otherSource = expectScript('echoArguments', { text: set.text, count: set.count, flag: set.flag }, 'report',
        { kind: 'equals', value: expectedReport(set, `${source}\n`) }, 'echo.other-source');
      for (const wrong of [otherText, otherSource]) {
        const ran = await harness.runSteps(targetId, [navigate('/'), wrong]);
        assert.equal(ran.result.state, 'Failed', JSON.stringify(ran.result.steps));
        assert.equal(ran.result.steps[1]?.outcome, 'failed');
      }
    });
  });

  describe(`inline page script arguments: ${targetId}`, () => {
    // An inline script's source is the plan's own text; it must reach the page unchanged too. An
    // inline script runs only in an approved plan. An inline script declares no parameters, so it
    // is called with one empty object.
    test('an inline script is called once with one empty object, and the page runs the plan\'s exact source', { criterion: 'AC-SPEC-36-09', timeout: TIMEOUT }, async () => {
      const source = scriptFileText(ECHO_ARGUMENTS_FILE);
      const script = inlineScript(source, 'read', { report: '/report' });
      const report = JSON.stringify({ callArguments: 1, names: [], textType: 'undefined', sourceSha256: sha256(source) });
      const plan = harness.plan(unsafePagePlan(targetId, [navigate('/'), expectScript(script, {}, 'report', { kind: 'equals', value: report }, 'echo.inline')]));
      const ran = await harness.run(plan, targetId, { standing: await approvedStanding(plan) });
      assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    });
  });

  describe(`no secret reaches a page script: ${targetId}`, () => {
    // After the page has been given a secret, the script still receives one object holding only
    // its declared arguments, with the values the plan wrote: the driver passes it nothing else.
    test('after a secret is typed into the page, the script is called with only its declared arguments', { criterion: 'AC-SPEC-36-20', timeout: TIMEOUT }, async () => {
      const source = scriptFileText(ECHO_ARGUMENTS_FILE);
      const secret = fakeSecretValue();
      const set: ArgumentSet = { text: 'plain text', count: 7, flag: true };
      const ran = await harness.runSteps(targetId, [
        navigate('/leaks.html'),
        fill(label('Access token'), secretValue(PAGE_SECRET)),
        echoCheck('echoArguments', set, source, 0),
      ], { secrets: fakeEnvironmentStore({ [PAGE_SECRET]: secret }) });
      assert.equal(ran.result.state, 'Passed', JSON.stringify(ran.result.steps));
    });
  });
}
