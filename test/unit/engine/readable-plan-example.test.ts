// The founder's example of a readable plan, from the spec, read into plain JSON. "Go to /login"
// resolves against the Origin: header, "Type secret TEST_USER" fills a secret by name, and the
// Criterion: header gives the Expect line after it its criterion id. Without an Origin: header a
// path stays a path, as JSON allows.
//
// The example has no Feature: or Spec: header, which meta needs before the plan can parse, so the
// expected JSON golden file holds the version, targets and steps, and only those are compared
// (SPEC-28's build notes).
//   - fixtures/readable-plans/sign-in.plan: the example, exactly as the spec gives it;
//   - golden/readable-plans/sign-in.json: the JSON it reads to.
// See docs/specs/SPEC-28-plan-authoring.md.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DEFAULT_LIMITS, readPlanText, type TextReading } from '@revisum/engine';
import { FIXTURES, GOLDEN } from '../../support/repository.ts';

type JsonRecord = Record<string, unknown>;

const EXAMPLE_TEXT = readFileSync(join(FIXTURES, 'readable-plans', 'sign-in.plan'), 'utf8');
const EXPECTED: JsonRecord = JSON.parse(readFileSync(join(GOLDEN, 'readable-plans', 'sign-in.json'), 'utf8'));
const ORIGIN_HEADER = 'Origin: https://staging.example.org';

function readExample(text: string = EXAMPLE_TEXT): TextReading {
  const read = readPlanText(text, DEFAULT_LIMITS);
  if (!read.ok) assert.fail(`the example was refused: ${JSON.stringify(read.error)}`);
  return read.value;
}

const fieldsOf = (json: unknown): JsonRecord => {
  assert.ok(typeof json === 'object' && json !== null && !Array.isArray(json), 'the reading is not a JSON object');
  return json as JsonRecord;
};
const stepsOf = (json: unknown): JsonRecord[] => fieldsOf(json)['steps'] as JsonRecord[];

test('the founder\'s example reads to the version, targets and steps of the expected JSON golden file', { criterion: 'AC-SPEC-28-06' }, () => {
  const json = fieldsOf(readExample().json);
  assert.deepEqual({ version: json['version'], targets: json['targets'], steps: json['steps'] }, EXPECTED);
});

test('in the founder\'s example, Go to /login resolves against the Origin: header', { criterion: 'AC-SPEC-28-06' }, () => {
  assert.deepEqual(stepsOf(readExample().json)[0], { type: 'navigate', url: 'https://staging.example.org/login' });
});

test('in the founder\'s example, Type secret TEST_USER is a fill step carrying the secret by name', { criterion: 'AC-SPEC-28-06' }, () => {
  const fill = stepsOf(readExample().json)[1];
  assert.equal(fill?.['type'], 'fill');
  assert.deepEqual(fill?.['value'], { secretName: 'TEST_USER' });
});

test('a different Origin: header resolves the same path against that origin instead', { criterion: 'AC-SPEC-28-06' }, () => {
  // The counter-example: the URL comes from the header, not from anything fixed in the reader.
  const moved = EXAMPLE_TEXT.replace(ORIGIN_HEADER, 'Origin: https://preview.example.org');
  assert.notEqual(moved, EXAMPLE_TEXT);
  assert.deepEqual(stepsOf(readExample(moved).json)[0], { type: 'navigate', url: 'https://preview.example.org/login' });
});

test('without an Origin: header, Go to /login reads as the path itself, with no error', { criterion: 'AC-SPEC-28-06' }, () => {
  const withoutOrigin = EXAMPLE_TEXT.split('\n').filter((line) => line !== ORIGIN_HEADER).join('\n');
  assert.notEqual(withoutOrigin, EXAMPLE_TEXT);
  assert.deepEqual(stepsOf(readExample(withoutOrigin).json)[0], { type: 'navigate', url: '/login' });
});
