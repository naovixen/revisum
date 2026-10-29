// Checks the shape of seed-provenance.json, the record of where each seeded file came from: a
// 40-hex research commit, a 64-hex source hash per file, unique `to` paths that stay inside this
// repository, and reused criteria whose spec criteria are defined in docs/specs/. The hashes are
// not compared with the files: seeded code has changed since, as code does; they are compared
// only while seeding (tools/seed-from-research.ts). Runs in `npm run lint`.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { readSpecCriteria } from './spec-criteria.ts';
import { reportProblems } from './workspace-packages.ts';

export const PROVENANCE_PATH = 'seed-provenance.json';

// A source file of the research prototypes and the hash it had at the seeded commit.
export type SeedSource = { readonly from: string; readonly sourceSha256: string };

// One seeded file. A few were merged from two prototype files: the second source is kept in
// `mergedFrom`, so every prototype file that was seeded stays on record and `to` stays unique.
export type SeededFile = SeedSource & { readonly to: string; readonly mergedFrom?: readonly SeedSource[] };

// Where each seeded file came from. The only file in this repository that points at the research
// repository. The commit's JSON key is quoted because its spelling is fixed by the record.
export type SeedProvenance = {
  readonly 'researchRepoCommit': string;
  readonly files: readonly SeededFile[];
  // Criteria of the research prototypes that this repository's criteria reuse, kept as values so
  // no name carries them.
  readonly reusedCriteria: readonly { readonly spikeCriterion: string; readonly specCriteria: readonly string[] }[];
};

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

const isText = (value: unknown): value is string => typeof value === 'string';

// The record, read field by field; throws, saying which field, when one has the wrong type.
export function decodeSeedProvenance(input: unknown): SeedProvenance {
  const commit = fieldOf(input, 'researchRepoCommit');
  const files = fieldOf(input, 'files');
  const reused = fieldOf(input, 'reusedCriteria') ?? [];
  if (!isText(commit)) throw new Error('researchRepoCommit is not text');
  if (!Array.isArray(files)) throw new Error('files is not a list');
  if (!Array.isArray(reused)) throw new Error('reusedCriteria is not a list');
  return {
    'researchRepoCommit': commit,
    files: files.map((file, index) => {
      const from = fieldOf(file, 'from');
      const to = fieldOf(file, 'to');
      const sourceSha256 = fieldOf(file, 'sourceSha256');
      const merged = fieldOf(file, 'mergedFrom') ?? [];
      if (!isText(from) || !isText(to) || !isText(sourceSha256)) throw new Error(`files[${index}] needs text from, to and sourceSha256`);
      if (!Array.isArray(merged)) throw new Error(`files[${index}].mergedFrom is not a list`);
      const mergedFrom = merged.map((source, sourceIndex) => {
        const mergedPath = fieldOf(source, 'from');
        const mergedHash = fieldOf(source, 'sourceSha256');
        if (!isText(mergedPath) || !isText(mergedHash)) throw new Error(`files[${index}].mergedFrom[${sourceIndex}] needs text from and sourceSha256`);
        return { from: mergedPath, sourceSha256: mergedHash };
      });
      return mergedFrom.length === 0 ? { from, to, sourceSha256 } : { from, to, sourceSha256, mergedFrom };
    }),
    reusedCriteria: reused.map((entry, index) => {
      const spikeCriterion = fieldOf(entry, 'spikeCriterion');
      const specCriteria = fieldOf(entry, 'specCriteria');
      if (!isText(spikeCriterion) || !Array.isArray(specCriteria) || !specCriteria.every(isText)) {
        throw new Error(`reusedCriteria[${index}] needs a spikeCriterion and a list of specCriteria`);
      }
      return { spikeCriterion, specCriteria };
    }),
  };
}

// A relative path with forward slashes that never climbs out of the repository.
export function isInsideRepository(path: string): boolean {
  if (path === '' || isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.includes('\\')) return false;
  return !path.split('/').some((segment) => segment === '..' || segment === '');
}

export function checkSeedProvenance(root: string): string[] {
  const path = join(root, PROVENANCE_PATH);
  if (!existsSync(path)) return [`${PROVENANCE_PATH} is missing`];
  let record: SeedProvenance;
  try {
    record = decodeSeedProvenance(JSON.parse(readFileSync(path, 'utf8')));
  } catch (error) {
    return [`${PROVENANCE_PATH}: ${error instanceof Error ? error.message : String(error)}`];
  }
  const problems: string[] = [];
  if (!/^[0-9a-f]{40}$/.test(record.researchRepoCommit)) problems.push(`${PROVENANCE_PATH}: the research commit is not 40 lower-case hex characters`);
  const seen = new Set<string>();
  record.files.forEach((file, index) => {
    for (const source of [file, ...(file.mergedFrom ?? [])]) {
      if (!/^[0-9a-f]{64}$/.test(source.sourceSha256)) problems.push(`${PROVENANCE_PATH}: files[${index}] (${file.to}) has a source hash that is not 64 hex characters`);
    }
    if (!isInsideRepository(file.to)) problems.push(`${PROVENANCE_PATH}: files[${index}] is seeded to ${file.to}, outside this repository`);
    if (seen.has(file.to)) problems.push(`${PROVENANCE_PATH}: more than one file is seeded to ${file.to}`);
    seen.add(file.to);
  });
  const defined = readSpecCriteria(root).all;
  for (const reused of record.reusedCriteria) {
    for (const criterion of reused.specCriteria) {
      if (!defined.has(criterion)) problems.push(`${PROVENANCE_PATH}: ${reused.spikeCriterion} is reused by ${criterion}, which is not a criterion in docs/specs/`);
    }
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('seed provenance check', checkSeedProvenance(process.cwd()));
