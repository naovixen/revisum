// Nothing in this repository may read, import or link a file that exists only in the research
// repository, and seed-provenance.json is the only file that names the research commit. Fails when:
//   - a file other than Markdown, docs/ and seed-provenance.json holds the research docs folder,
//     a path into the research repository's folder, or any `from` path of the seed record;
//   - any file but seed-provenance.json, docs included, holds the research commit or a prefix of
//     it of 7 or more characters, which Git would accept as naming it.
// Every file is read, not only Git's tracked ones, so a scratch copy that is no repository is
// checked the same way; installed packages, build output and test results are skipped.
// Runs in `npm run lint`. See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeSeedProvenance, PROVENANCE_PATH } from './check-seed-provenance.ts';
import { RESULTS_FOLDER } from './test-results.ts';
import { reportProblems } from './workspace-packages.ts';

// Built from parts so this file does not hold the text it looks for.
const RESEARCH_DOCS_FOLDER = ['docs', 'research', ''].join('/');
// The research repository's folder on the founder's machine, written with either separator.
const RESEARCH_FOLDER = new RegExp(`(?<![\\w.])${['E:', 'core'].join('[\\\\/]+')}(?![\\w.-])`, 'i');
const SHORTEST_COMMIT_PREFIX = 7;
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', 'dist', '.browsers', '.idea', '.vscode', RESULTS_FOLDER]);
const SKIPPED_FILES = /\.(tsbuildinfo|log)$/;

function listFiles(root: string, folder = ''): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, folder), { withFileTypes: true })) {
    if (SKIPPED_FOLDERS.has(entry.name)) continue;
    const path = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(root, path));
    else if (entry.isFile() && !SKIPPED_FILES.test(entry.name)) files.push(path);
  }
  return files;
}

// Docs may describe where the design came from; they may not name the commit.
const mayMentionResearchPaths = (file: string): boolean => file.endsWith('.md') || file.startsWith('docs/');

export function checkResearchLinks(root: string): string[] {
  let record;
  try {
    record = decodeSeedProvenance(JSON.parse(readFileSync(join(root, PROVENANCE_PATH), 'utf8')));
  } catch (error) {
    return [`cannot read ${PROVENANCE_PATH}: ${error instanceof Error ? error.message : String(error)}`];
  }
  const commitPrefix = record.researchRepoCommit.slice(0, SHORTEST_COMMIT_PREFIX).toLowerCase();
  // A prefix counts only at the start of a run of hex characters, so a longer digest that happens
  // to contain it is not mistaken for the commit.
  const commitPattern = commitPrefix.length < SHORTEST_COMMIT_PREFIX ? undefined : new RegExp(`(?<![0-9a-f])${commitPrefix}`, 'i');
  // Seeded-from paths outside the research docs folder, which the folder test would not catch.
  const otherSources = [...new Set(record.files.flatMap((file) => [file.from, ...(file.mergedFrom ?? []).map((source) => source.from)]))].filter((from) => !from.startsWith(RESEARCH_DOCS_FOLDER));

  const problems: string[] = [];
  for (const file of listFiles(root)) {
    if (file === PROVENANCE_PATH) continue;
    const text = readFileSync(join(root, file), 'latin1');
    if (commitPattern?.test(text) === true) problems.push(`${file} names the research commit; only ${PROVENANCE_PATH} may`);
    if (mayMentionResearchPaths(file)) continue;
    if (text.includes(RESEARCH_DOCS_FOLDER)) problems.push(`${file} links the research docs folder ${RESEARCH_DOCS_FOLDER}, which exists only in the research repository`);
    if (RESEARCH_FOLDER.test(text)) problems.push(`${file} points into the research repository's folder`);
    const source = otherSources.find((from) => text.includes(from));
    if (source !== undefined) problems.push(`${file} links ${source}, a file seeded from the research repository`);
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('research link check', checkResearchLinks(process.cwd()));
