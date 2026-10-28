// The shared types compile as the spec describes them: every error-code union is closed, and
// every type the spec declares resolves to a declaration in core.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { compileFiles } from './scratch-compiler.ts';

const EXHAUSTIVENESS_FILE = join(REPOSITORY_ROOT, 'test', 'proofs', 'error-code-exhaustiveness.ts');
const EXPECTED_ERROR_LINE = /^\s*\/\/\s*@ts-expect-error\b/;

// ---- Closed error-code unions -------------------------------------------------------------------

test('a switch over each error-code union compiles only when it handles every code', { criterion: 'AC-SPEC-27-01', timeout: 300_000 }, () => {
  const compiled = compileFiles([EXHAUSTIVENESS_FILE]);
  assert.equal(compiled.passed, true, compiled.output);
});

test('removing the expected-error markers makes every switch that forgets a code fail to compile', { criterion: 'AC-SPEC-27-01', timeout: 300_000 }, () => {
  // The mutant: the same file with each @ts-expect-error line deleted. Every switch that leaves a
  // code out must now be a compile error of its own, so the check above can fail.
  const source = readFileSync(EXHAUSTIVENESS_FILE, 'utf8');
  const lines = source.split(/\r?\n/);
  const markers = lines.filter((line) => EXPECTED_ERROR_LINE.test(line)).length;
  assert.equal(markers, 6, 'one forgetful switch per error-code union');
  const mutant = lines.filter((line) => !EXPECTED_ERROR_LINE.test(line)).join('\n');
  const compiled = compileFiles([{ name: 'error-code-exhaustiveness-mutant.ts', source: mutant }]);
  assert.equal(compiled.passed, false, 'the mutant compiled, so a forgotten code would go unnoticed');
  assert.equal(compiled.errors.length, markers, compiled.output);
});

// ---- Every declared type resolves to core -------------------------------------------------------

function specTypeBlock(): string {
  const specs = join(REPOSITORY_ROOT, 'docs', 'specs');
  const file = readdirSync(specs).find((name) => name.endsWith('-shared-types-and-events.md'));
  assert.ok(file !== undefined, 'the shared-types spec is in docs/specs');
  const text = readFileSync(join(specs, file), 'utf8');
  const section = text.slice(text.indexOf('## Interfaces and types'));
  const block = /```ts\r?\n([\s\S]*?)```/.exec(section);
  assert.ok(block?.[1] !== undefined, 'the spec has a TypeScript block under "Interfaces and types"');
  return block[1];
}

// The names the spec's TypeScript block declares, skipping those marked as additions: each of
// those lands with the later spec that first uses it.
function declaredNames(block: string): string[] {
  const lines = block.split(/\r?\n/);
  const names: string[] = [];
  lines.forEach((line, index) => {
    const declaration = /^export\s+(?:type|interface|const)\s+([A-Za-z][A-Za-z0-9_]*)/.exec(line);
    if (declaration?.[1] === undefined) return;
    const markedOnLine = /\/\/\s*addition\b/i.test(line);
    // The comment block directly above the declaration may open with "Addition:".
    let above = index - 1;
    let markedAbove = false;
    while (above >= 0 && /^\s*\/\//.test(lines[above] ?? '')) {
      if (/^\s*\/\/\s*Addition\b/.test(lines[above] ?? '')) markedAbove = true;
      above -= 1;
    }
    if (!markedOnLine && !markedAbove) names.push(declaration[1]);
  });
  return names;
}

// Plan types the block names without declaring: they are declared with the plan language in core.
const NAMED_PLAN_TYPES = ['Locator', 'ActionStep'];

const reexportFile = (names: readonly string[]) => ({
  name: 'shared-type-names.ts',
  source: `export type {\n  ${names.join(',\n  ')},\n} from '@revisum/engine';\n`,
});

test('every type the spec declares resolves to a declaration exported by core', { criterion: 'AC-SPEC-27-02', timeout: 300_000 }, () => {
  const names = declaredNames(specTypeBlock());
  // A floor, so a change to the spec's layout cannot silently empty the list.
  for (const expected of ['Result', 'Session', 'DerivedActor', 'EventSink', 'PERSON_ACTOR_TYPES', 'Thresholds', 'SinkError', 'CliErrorCode', 'GuaranteeLevel']) {
    assert.ok(names.includes(expected), `${expected} was not found in the spec's type block`);
  }
  const compiled = compileFiles([reexportFile([...names, ...NAMED_PLAN_TYPES])]);
  assert.equal(compiled.passed, true, compiled.output);
});

test('a type name that core does not declare fails the resolution check', { criterion: 'AC-SPEC-27-02', timeout: 300_000 }, () => {
  // The counter-example: one invented name among the real ones must fail, and be named.
  const names = [...declaredNames(specTypeBlock()), ...NAMED_PLAN_TYPES, 'NoSuchSharedType'];
  const compiled = compileFiles([reexportFile(names)]);
  assert.equal(compiled.passed, false, 'an undeclared name resolved');
  assert.ok(compiled.errors.some((line) => line.includes('NoSuchSharedType')), compiled.output);
});
