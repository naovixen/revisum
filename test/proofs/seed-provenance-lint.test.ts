// The lint checks the shape of seed-provenance.json: a 40-hex research commit, 64-hex source
// hashes, unique `to` paths inside this repository, and reused criteria whose spec ids exist in
// docs/specs/. Each test breaks one of those in a throw-away copy of the repository and runs
// the lint commands over it.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { after, before, test } from 'node:test';
import { criterionId } from '../support/criterion-ids.ts';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';
import { assertLintFails, assertLintPasses, editJson, lintWithEdits } from './scratch-edits.ts';

const PROVENANCE_PATH = 'seed-provenance.json';
const TIMEOUT = 300_000;

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

type SeededFile = { from: string; to: string; sourceSha256: string };
type ReusedCriterion = { spikeCriterion: string; specCriteria: string[] };

const filesOf = (record: Record<string, unknown>): SeededFile[] => record['files'] as SeededFile[];
const firstFile = (record: Record<string, unknown>): SeededFile => {
  const file = filesOf(record)[0];
  if (file === undefined) throw new Error(`${PROVENANCE_PATH} records no files`);
  return file;
};

const lintWithProvenance = (change: (record: Record<string, unknown>) => void) =>
  lintWithEdits(scratch, { [PROVENANCE_PATH]: editJson(change) });

test('control: the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-00-11', timeout: TIMEOUT }, () => {
  assertLintPasses(scratch.lint());
});

test('the lint fails when the research commit is not 40 hex characters', { criterion: 'AC-SPEC-00-11', timeout: TIMEOUT }, () => {
  const outcome = lintWithProvenance((record) => { record['researchRepoCommit'] = String(record['researchRepoCommit']).slice(0, 39); });
  assertLintFails(outcome, [PROVENANCE_PATH]);
});

test('the lint fails when a source hash is not 64 hex characters', { criterion: 'AC-SPEC-00-11', timeout: TIMEOUT }, () => {
  const outcome = lintWithProvenance((record) => {
    const file = firstFile(record);
    file.sourceSha256 = `${file.sourceSha256.slice(0, 63)}g`;
  });
  assertLintFails(outcome, [PROVENANCE_PATH]);
});

test('the lint fails when two seeded files share a `to` path', { criterion: 'AC-SPEC-00-11', timeout: TIMEOUT }, () => {
  const outcome = lintWithProvenance((record) => {
    const files = filesOf(record);
    const [first, second] = files;
    if (first === undefined || second === undefined) throw new Error(`${PROVENANCE_PATH} records fewer than two files`);
    second.to = first.to;
  });
  assertLintFails(outcome, [PROVENANCE_PATH]);
});

test('the lint fails when a `to` path lies outside the repository', { criterion: 'AC-SPEC-00-11', timeout: TIMEOUT }, () => {
  const outcome = lintWithProvenance((record) => { firstFile(record).to = '../outside-the-repository.json'; });
  assertLintFails(outcome, ['outside-the-repository.json']);
});

test('the lint fails when a reused criterion names a spec criterion that does not exist', { criterion: 'AC-SPEC-00-11', timeout: TIMEOUT }, () => {
  const missing = criterionId(99, 1);
  const outcome = lintWithProvenance((record) => {
    const reused = (record['reusedCriteria'] as ReusedCriterion[])[0];
    if (reused === undefined) throw new Error(`${PROVENANCE_PATH} records no reused criteria`);
    reused.specCriteria = [...reused.specCriteria, missing];
  });
  assertLintFails(outcome, [missing]);
});
