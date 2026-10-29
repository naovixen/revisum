// Nothing in this repository may read, import or link a file that exists only in the research
// repository, and seed-provenance.json is the only file that names the research commit.
// tools/check-research-links.ts runs in the lint and fails when:
//   - a file other than Markdown, docs/ and seed-provenance.json holds a research-docs path, a path
//     into the research repository's folder, or any `from` path of the seed record;
//   - any file but seed-provenance.json, docs included, holds the research commit or a prefix of it
//     of 7 or more characters.
// Each test plants one file in a throw-away copy of the repository and runs the lint commands.
// The planted text is built at run time from the seed record, so this file holds none of it.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';
import { assertLintFails, assertLintPasses, lintWithEdits } from './scratch-edits.ts';

const LINK_CHECK = 'check-research-links';
const TIMEOUT = 300_000;

// The seed record's fields are read by their JSON names.
const record: Readonly<Record<string, unknown>> = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'seed-provenance.json'), 'utf8'));
const researchCommit = String(record['researchRepoCommit']);
const seededFiles = record['files'];
const seededFrom = Array.isArray(seededFiles) ? String(Object(seededFiles[0]).from) : '';
const researchDocsFolder = ['docs', 'research', ''].join('/');
const researchDrive = ['E:', 'core'];

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

test('control: the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-00-17', timeout: TIMEOUT }, () => {
  assertLintPasses(scratch.lint());
});

// ---- Links into the research repository ---------------------------------------------------------

test('the lint fails on a tool that reads a research-docs path', { criterion: 'AC-SPEC-00-17', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    'tools/planted-reader.ts': `export const studyNotesPath = '${researchDocsFolder}notes/summary.json';\n`,
  });
  assertLintFails(outcome, ['planted-reader.ts'], LINK_CHECK);
});

test('the lint fails on a config file that points into the research repository with backslashes', { criterion: 'AC-SPEC-00-17', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    'fixtures/planted-config.json': `${JSON.stringify({ source: `${researchDrive.join('\\')}\\notes` }, null, 2)}\n`,
  });
  assertLintFails(outcome, ['planted-config.json'], LINK_CHECK);
});

test('the lint fails on a CI file that points into the research repository with forward slashes', { criterion: 'AC-SPEC-00-17', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    '.github/workflows/planted.yml': `name: planted\non: push\njobs:\n  copy:\n    runs-on: ubuntu-24.04\n    steps:\n      - run: cp ${researchDrive.join('/')}/notes.md .\n`,
  });
  assertLintFails(outcome, ['planted.yml'], LINK_CHECK);
});

test('the lint fails on a test that links a file the seed record copied from', { criterion: 'AC-SPEC-00-17', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    'test/proofs/planted-original.ts': `export const originalPath = '${seededFrom}';\n`,
  });
  assertLintFails(outcome, ['planted-original.ts'], LINK_CHECK);
});

test('counter-example: a Markdown note under docs may mention a research-docs path', { criterion: 'AC-SPEC-00-17', timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithEdits(scratch, {
    'docs/planted-history.md': `# History\n\nThe design came from ${researchDocsFolder}, kept in the research repository.\n`,
  }));
});

// ---- The research commit ------------------------------------------------------------------------

test('the lint fails on a source file that holds the research commit', { criterion: 'AC-SPEC-00-17', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, { 'packages/engine/src/planted-origin.ts': `export const originCommit = '${researchCommit}';\n` });
  assertLintFails(outcome, ['planted-origin.ts'], LINK_CHECK);
});

test('the lint fails on a doc that holds a 7-character prefix of the research commit', { criterion: 'AC-SPEC-00-17', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    'docs/planted-history.md': `# History\n\nSeeded from commit ${researchCommit.slice(0, 7)}.\n`,
  });
  assertLintFails(outcome, ['planted-history.md'], LINK_CHECK);
});

test('counter-example: a 6-character prefix of the research commit is too short to name it', { criterion: 'AC-SPEC-00-17', timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithEdits(scratch, {
    'docs/planted-history.md': `# History\n\nThe colour is #${researchCommit.slice(0, 6)}.\n`,
  }));
});
