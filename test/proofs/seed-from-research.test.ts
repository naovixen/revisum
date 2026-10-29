// Seeding copies named files from one commit of the research repository into this one and records
// where each came from: `node tools/seed-from-research.ts --research <repository> --commit <hash>
// --files <list>`, run in the product repository. The list is a JSON file of `{ from, to }`
// pairs. The tool reads each file from that commit with `git show`, never from the research
// working tree, writes it to `to`, and writes seed-provenance.json with the commit and each
// file's sha256. It fails, naming the file, when the commit lacks one.
// A throw-away Git repository built here stands in for the research repository.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createGitRepository, type GitRepository } from '../support/git-repository.ts';
import { describeRun, runTool, type ToolRun } from '../support/tool-runs.ts';

const sha256Of = (content: string | Uint8Array): string => createHash('sha256').update(content).digest('hex');

const ENGINE_SOURCE = 'export const runPlan = (): string => "first version";\n';
const ENGINE_SOURCE_LATER = 'export const runPlan = (): string => "later version";\n';
const NOTES = '# Study notes\r\nLine endings stay as committed.\r\n';
// Every byte value, so any text conversion on the way would show.
const BINARY = Uint8Array.from({ length: 256 }, (_unused, index) => index);

let research: GitRepository;
let seededCommit: string;
let product: string;

before(() => {
  research = createGitRepository();
  seededCommit = research.commit({
    files: { 'studies/skeleton/engine.ts': ENGINE_SOURCE, 'studies/skeleton/notes.md': NOTES, 'studies/report/pixels.bin': BINARY },
    message: 'Record the skeleton study',
  });
  // A later commit changes one file and adds another; seeding the earlier commit must see neither.
  research.commit({
    files: { 'studies/skeleton/engine.ts': ENGINE_SOURCE_LATER, 'studies/skeleton/added-later.ts': 'export {};\n' },
    message: 'Revise the skeleton study',
  });
  research.write('studies/skeleton/engine.ts', 'export const uncommitted = true;\n');
});
after(() => { research.dispose(); });

function seed(pairs: readonly { readonly from: string; readonly to: string }[], commit = seededCommit): ToolRun {
  const listPath = join(product, '..', 'seed-files.json');
  writeFileSync(listPath, `${JSON.stringify(pairs, null, 2)}\n`);
  return runTool('seed-from-research.ts', ['--research', research.root, '--commit', commit, '--files', listPath], {
    cwd: product, environment: research.environment,
  });
}

const freshProduct = (): string => {
  const folder = mkdtempSync(join(tmpdir(), 'seeded-'));
  const root = join(folder, 'product');
  mkdirSync(root);
  return root;
};

const PAIRS = [
  { from: 'studies/skeleton/engine.ts', to: 'packages/engine/src/run-plan.ts' },
  { from: 'studies/skeleton/notes.md', to: 'docs/notes.md' },
  { from: 'studies/report/pixels.bin', to: 'fixtures/report/pixels.bin' },
];

// seed-provenance.json, read by its JSON field names.
type Provenance = Readonly<Record<string, unknown>>;
type SeededFile = { readonly from?: unknown; readonly to?: unknown; readonly sourceSha256?: unknown };

test('seeding copies each named file byte for byte from the given commit', { criterion: 'AC-SPEC-00-11' }, () => {
  product = freshProduct();
  try {
    const run = seed(PAIRS);
    assert.equal(run.passed, true, describeRun(run));
    assert.equal(readFileSync(join(product, 'packages/engine/src/run-plan.ts'), 'utf8'), ENGINE_SOURCE);
    assert.equal(readFileSync(join(product, 'docs/notes.md'), 'utf8'), NOTES);
    assert.deepEqual(new Uint8Array(readFileSync(join(product, 'fixtures/report/pixels.bin'))), BINARY);
  } finally {
    rmSync(join(product, '..'), { recursive: true, force: true });
  }
});

test('seeding records the research commit and each file\'s source sha256 in seed-provenance.json', { criterion: 'AC-SPEC-00-11' }, () => {
  product = freshProduct();
  try {
    const run = seed(PAIRS);
    assert.equal(run.passed, true, describeRun(run));
    const provenance: Provenance = JSON.parse(readFileSync(join(product, 'seed-provenance.json'), 'utf8'));
    assert.equal(provenance['researchRepoCommit'], seededCommit);
    const recorded = ((provenance['files'] ?? []) as readonly SeededFile[]).map((file) => ({ from: file.from, to: file.to, sourceSha256: file.sourceSha256 }));
    assert.deepEqual(recorded, [
      { ...PAIRS[0], sourceSha256: sha256Of(ENGINE_SOURCE) },
      { ...PAIRS[1], sourceSha256: sha256Of(NOTES) },
      { ...PAIRS[2], sourceSha256: sha256Of(BINARY) },
    ]);
  } finally {
    rmSync(join(product, '..'), { recursive: true, force: true });
  }
});

test('seeding fails, naming the file, when the commit does not contain it', { criterion: 'AC-SPEC-00-11' }, () => {
  product = freshProduct();
  try {
    // The file exists in a later commit and in the working tree, but not in the seeded commit.
    const run = seed([...PAIRS, { from: 'studies/skeleton/added-later.ts', to: 'packages/engine/src/added-later.ts' }]);
    assert.equal(run.passed, false, describeRun(run));
    assert.ok(run.output.includes('studies/skeleton/added-later.ts'), describeRun(run));
    assert.ok(!existsSync(join(product, 'packages/engine/src/added-later.ts')), 'a file the commit lacks was written');
  } finally {
    rmSync(join(product, '..'), { recursive: true, force: true });
  }
});

test('counter-example: the same file seeds from the later commit that holds it', { criterion: 'AC-SPEC-00-11' }, () => {
  product = freshProduct();
  try {
    const later = research.git('rev-parse', 'HEAD');
    const run = seed([{ from: 'studies/skeleton/added-later.ts', to: 'packages/engine/src/added-later.ts' }], later);
    assert.equal(run.passed, true, describeRun(run));
    assert.equal(readFileSync(join(product, 'packages/engine/src/added-later.ts'), 'utf8'), 'export {};\n');
  } finally {
    rmSync(join(product, '..'), { recursive: true, force: true });
  }
});
