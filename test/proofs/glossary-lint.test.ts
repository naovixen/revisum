// docs/glossary.md maps each domain term to its code name, and tools/check-glossary.ts keeps it
// true in the lint:
//   - every code name in the Domain terms and Metrics tables resolves to an exported declaration,
//     a declared string or property name, or (when it looks like a path) a file in the repository;
//     a row whose "Where" says only "planned" is skipped, a partly planned one is checked;
//   - every type the engine's public API exports, through `export *` into contracts, is listed;
//   - the Standard names table equals the naming lint's standardNames.
// Each test changes the glossary in a throw-away copy of the repository and runs the lint.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { after, before, test } from 'node:test';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';
import { assertLintFails, assertLintPasses, lintWithEdits } from './scratch-edits.ts';

const GLOSSARY_PATH = 'docs/glossary.md';
const GLOSSARY_CHECK = 'check-glossary';
const ANCHOR_ROW = '| Engine | `engine` package |';
const TIMEOUT = 300_000;

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

// The glossary with one extra Domain terms row, placed before the Engine row.
const withRow = (row: string) => (text: string): string => {
  if (!text.includes(ANCHOR_ROW)) throw new Error(`${GLOSSARY_PATH} has no Engine row to place the new row beside`);
  return text.replace(ANCHOR_ROW, `${row}\n${ANCHOR_ROW}`);
};

// The glossary with one exact piece of text removed.
const without = (removed: string) => (text: string): string => {
  if (!text.includes(removed)) throw new Error(`${GLOSSARY_PATH} does not hold ${JSON.stringify(removed)}`);
  return text.replace(removed, '');
};

test('control: the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-00-16', timeout: TIMEOUT }, () => {
  assertLintPasses(scratch.lint());
});

// ---- Code names resolve -------------------------------------------------------------------------

test('the lint fails on a row whose code name is no exported declaration', { criterion: 'AC-SPEC-00-16', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    [GLOSSARY_PATH]: withRow('| Planted term | `plantedMissingExport` | `engine`, exists | A term whose code name names nothing |'),
  });
  assertLintFails(outcome, ['plantedMissingExport'], GLOSSARY_CHECK);
});

test('the lint fails on a partly planned row whose existing code name is missing', { criterion: 'AC-SPEC-00-16', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    [GLOSSARY_PATH]: withRow('| Planted term | `plantedMissingExport` | `engine`, exists; driver planned (SPEC-06) | A term whose code name names nothing |'),
  });
  assertLintFails(outcome, ['plantedMissingExport'], GLOSSARY_CHECK);
});

test('the lint fails on a row whose code name is a path that does not exist', { criterion: 'AC-SPEC-00-16', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    [GLOSSARY_PATH]: withRow('| Planted tool | `tools/planted-missing-tool.ts` | `tools`, exists | A tool that is not there |'),
  });
  assertLintFails(outcome, ['tools/planted-missing-tool.ts'], GLOSSARY_CHECK);
});

test('counter-example: a row whose "Where" says only "planned" is not checked', { criterion: 'AC-SPEC-00-16', timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithEdits(scratch, {
    [GLOSSARY_PATH]: withRow('| Planted term | `plantedMissingExport` | planned | A term whose code is still to come |'),
  }));
});

// ---- The engine's public API is listed ----------------------------------------------------------

test('the lint fails when an exported engine type is taken out of the glossary', { criterion: 'AC-SPEC-00-16', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    [GLOSSARY_PATH]: (text) => text.split('\n').filter((line) => !line.includes('`AiText`')).join('\n'),
  });
  assertLintFails(outcome, ['AiText'], GLOSSARY_CHECK);
});

test('the lint fails when a contracts type the engine re-exports is taken out of the glossary', { criterion: 'AC-SPEC-00-16', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, { [GLOSSARY_PATH]: without('`LeakScanner`, ') });
  assertLintFails(outcome, ['LeakScanner'], GLOSSARY_CHECK);
});

// ---- Standard names -----------------------------------------------------------------------------

test('the lint fails when a standard name is dropped from the glossary', { criterion: 'AC-SPEC-00-16', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, { [GLOSSARY_PATH]: without('| mcp | Model Context Protocol |\n') });
  assertLintFails(outcome, ['mcp'], GLOSSARY_CHECK);
});

test('the lint fails when a standard name is given another full name', { criterion: 'AC-SPEC-00-16', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    [GLOSSARY_PATH]: (text) => without('| jwt | JSON Web Token |')(text).replace('| oidc | OpenID Connect |', '| oidc | OpenID Connect |\n| jwt | JSON Web Tokens |'),
  });
  assertLintFails(outcome, ['jwt'], GLOSSARY_CHECK);
});
