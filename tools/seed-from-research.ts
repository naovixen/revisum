// Seeds this repository with files from one commit of the research repository and records where
// each came from in seed-provenance.json, the only file here that names the research commit.
//   node tools/seed-from-research.ts --research <repository> --commit <hash> --files <list.json>
// The list is a JSON file of { "from": <path in the research repository>, "to": <path here> }
// pairs. Each file is read from the commit with `git show`, never from the research working
// tree, and written byte for byte. When the commit lacks any listed file, seeding fails, naming
// it, and writes nothing. The repository being seeded is the working folder; this tool names no
// research path itself.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decodeSeedProvenance, isInsideRepository, PROVENANCE_PATH, type SeedProvenance, type SeededFile } from './check-seed-provenance.ts';

export type SeedPair = { readonly from: string; readonly to: string };

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

export function decodeSeedPairs(input: unknown): SeedPair[] {
  if (!Array.isArray(input)) throw new Error('the file list is not a JSON list of { from, to } pairs');
  return input.map((entry, index) => {
    const from = fieldOf(entry, 'from');
    const to = fieldOf(entry, 'to');
    if (typeof from !== 'string' || from === '' || typeof to !== 'string' || to === '') {
      throw new Error(`entry ${index} of the file list needs a "from" and a "to" path`);
    }
    if (!isInsideRepository(to)) throw new Error(`entry ${index} of the file list writes outside this repository: ${to}`);
    return { from, to };
  });
}

function gitIn(repository: string, words: readonly string[]): Buffer {
  return execFileSync('git', ['-C', repository, ...words], { ['maxBuffer']: 1024 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

// True when the commit holds a file at the path.
function commitHolds(repository: string, commit: string, path: string): boolean {
  try {
    return gitIn(repository, ['cat-file', '-t', `${commit}:${path}`]).toString('utf8').trim() === 'blob';
  } catch {
    return false;
  }
}

export function seedFromResearch(root: string, repository: string, commitName: string, pairs: readonly SeedPair[]): SeedProvenance {
  const commit = gitIn(repository, ['rev-parse', '--verify', `${commitName}^{commit}`]).toString('utf8').trim();
  const missing = pairs.filter((pair) => !commitHolds(repository, commit, pair.from)).map((pair) => pair.from);
  if (missing.length > 0) throw new Error(`commit ${commit} does not contain: ${missing.join(', ')}`);

  const files: SeededFile[] = pairs.map((pair) => {
    const content = gitIn(repository, ['show', `${commit}:${pair.from}`]);
    const target = join(root, pair.to);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return { from: pair.from, to: pair.to, sourceSha256: createHash('sha256').update(content).digest('hex') };
  });

  // Seeding again from the same commit adds to the record; another commit starts a new one.
  // Reused criteria are kept either way: they map criteria, not files.
  const recordPath = join(root, PROVENANCE_PATH);
  const earlier = existsSync(recordPath) ? decodeSeedProvenance(JSON.parse(readFileSync(recordPath, 'utf8'))) : undefined;
  const seededPaths = new Set(files.map((file) => file.to));
  const keptFiles = earlier !== undefined && earlier.researchRepoCommit === commit
    ? earlier.files.filter((file) => !seededPaths.has(file.to))
    : [];
  const record: SeedProvenance = {
    'researchRepoCommit': commit,
    files: [...keptFiles, ...files],
    reusedCriteria: earlier?.reusedCriteria ?? [],
  };
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function main(words: readonly string[]): number {
  const valueAfter = (flag: string): string | undefined => {
    const index = words.indexOf(flag);
    return index === -1 ? undefined : words[index + 1];
  };
  const repository = valueAfter('--research');
  const commit = valueAfter('--commit');
  const list = valueAfter('--files');
  if (repository === undefined || commit === undefined || list === undefined) {
    console.error('usage: node tools/seed-from-research.ts --research <repository> --commit <hash> --files <list.json>');
    return 2;
  }
  try {
    const record = seedFromResearch(process.cwd(), repository, commit, decodeSeedPairs(JSON.parse(readFileSync(list, 'utf8'))));
    console.log(`seeded ${record.files.length} file(s) from ${record.researchRepoCommit}; recorded in ${PROVENANCE_PATH}`);
    return 0;
  } catch (error) {
    console.error(`seeding failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
