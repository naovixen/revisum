// Every phase-1 guarantee the product publishes, mapped to the CI test that proves it. The gates
// step reads the test results in .test-results/ (tools/run-test-folder.ts) and:
//   - fails when a mapped test is in no result or did not pass;
//   - writes .test-results/guarantees.md, each guarantee with the class this run shows: its proven
//     class when its test passed, else its weaker class;
//   - fails when docs/guarantees.md, the published table, differs from what this run generates.
// A row whose test comes with a later spec is pending: it shows its weaker class and does not fail
// while any of its specs is unticked in START.md. Once they are all ticked the pending mark fails,
// so it cannot outlive its reason.
//   node tools/guarantee-map.ts           the gates step
//   node tools/guarantee-map.ts --write   regenerate docs/guarantees.md from a green run
// Disclosed, not tested in phase 1: that a plan is semantically right and AI judgements are right
// (statistical); that prompt injection is prevented (not achievable); HTTP and identity
// allow-lists, retries and tokens (phase 2 protocol packs).
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { failed, readTestResults, RESULTS_FOLDER, type TestResults } from './test-results.ts';

export type GuaranteeRow =
  | 'ai-output-only-as-plan' | 'known-actions-only' | 'lifecycle-no-skip' | 'declared-log-fields' | 'targets-not-substituted'
  | 'browser-egress-allow-list' | 'secrets-absent' | 'pii-masked-in-pixels' | 'no-pii-in-reports' | 'same-inputs-same-result'
  | 'adapters-substitutable' | 'report-runs-no-content' | 'actions-tamper-evident' | 'spec-to-commit-trace' | 'person-approval';

export type GuaranteeEntry = {
  // The test that proves the row, as "<file>#<full name>"; null while the row is pending.
  readonly testId: string | null;
  // What the row is shown as when its test passes: structural, type-level or runtime, and how far.
  readonly provenClass: string;
  // What it is shown as when its test is missing or fails.
  readonly weakerClass: string;
  // For a row whose test comes with later specs: those specs' numbers, as START.md lists them.
  readonly pendingUntilSpecs?: readonly number[];
};

export type GuaranteeMap = Readonly<Record<GuaranteeRow, GuaranteeEntry>>;

export const NOT_PROVEN = 'claimed, not proven by CI';
export const PUBLISHED_TABLE = 'docs/guarantees.md';
const RUN_TABLE = 'guarantees.md';

const RUN_GUARANTEES = 'test/proofs/run-guarantees.test.ts';
const DRIVER_CONTRACT = 'test/contract/driver-contract.test.ts';

export const GUARANTEE_MAP: GuaranteeMap = {
  'ai-output-only-as-plan': {
    testId: `${RUN_GUARANTEES}#(b) AI containment: hostile plans are rejected before any side effect > an AI planner's output is only usable after parsing`,
    provenClass: 'runtime-checked', weakerClass: NOT_PROVEN,
  },
  'known-actions-only': {
    testId: 'test/unit/engine/plan-closed-language.test.ts#rejects an unknown step type with unknown_step at $.steps[6].type',
    provenClass: 'structural, for plans without unsafe features', weakerClass: NOT_PROVEN,
  },
  'lifecycle-no-skip': {
    testId: 'test/proofs/type-check.test.ts#the test set and the package sources it imports type-check strictly',
    provenClass: 'type-level', weakerClass: NOT_PROVEN,
  },
  'declared-log-fields': {
    testId: `${RUN_GUARANTEES}#(c) logging manifest > every event of a real run uses only manifest fields and contains no typed value`,
    provenClass: 'structural, for field names only', weakerClass: NOT_PROVEN,
  },
  'targets-not-substituted': {
    testId: `${RUN_GUARANTEES}#(e) targets are never substituted > unsupported device and unregistered adapter become explicit TargetUnavailable results`,
    provenClass: 'runtime, partial', weakerClass: NOT_PROVEN,
  },
  'browser-egress-allow-list': {
    testId: `${DRIVER_CONTRACT}#contract: cdp-chromium > blocks every origin not on the allow-list and records it`,
    provenClass: 'runtime, partial: the browser is held to the allow-list; the isolated runner enforces egress later', weakerClass: NOT_PROVEN,
  },
  'secrets-absent': {
    testId: 'test/proofs/secret-leak-scan.test.ts#secret echoes never reach a run\'s outputs > cdp-chromium: the scan finds the planted canary and no echo of the secret in any form',
    provenClass: 'type-level; runtime, partial, for echoes', weakerClass: NOT_PROVEN,
  },
  'pii-masked-in-pixels': {
    testId: `${RUN_GUARANTEES}#(d) redaction by default > cdp-chromium: PII fields are solid black in screenshots, and visible without the mask`,
    provenClass: 'runtime, partial', weakerClass: NOT_PROVEN,
  },
  'no-pii-in-reports': {
    testId: null, provenClass: 'runtime', weakerClass: NOT_PROVEN, pendingUntilSpecs: [9, 12],
  },
  'same-inputs-same-result': {
    testId: `${RUN_GUARANTEES}#(a) replay: same manifest, same result hash > cdp-chromium: two runs give identical manifest, result hash and event log`,
    provenClass: 'runtime, partial', weakerClass: NOT_PROVEN,
  },
  'adapters-substitutable': {
    testId: `${DRIVER_CONTRACT}#contract: cdp-chromium > runs the sign-up flow to Passed and captures two PNGs`,
    provenClass: 'runtime', weakerClass: NOT_PROVEN,
  },
  'report-runs-no-content': {
    testId: 'test/unit/report/report-generator.test.ts#each HTML file is self-contained: inline CSS, no script, no handler, no external reference',
    provenClass: 'type-level and runtime', weakerClass: NOT_PROVEN,
  },
  'actions-tamper-evident': {
    testId: null, provenClass: 'runtime', weakerClass: NOT_PROVEN, pendingUntilSpecs: [14],
  },
  'spec-to-commit-trace': {
    testId: null, provenClass: 'runtime', weakerClass: NOT_PROVEN, pendingUntilSpecs: [14],
  },
  'person-approval': {
    testId: 'test/unit/engine/agent-lockdown-approval.test.ts#the maintainer\'s merge to the protected branch records a declared approval with a person-declared actor',
    provenClass: 'runtime-checked, recorded as declared', weakerClass: NOT_PROVEN,
  },
};

const specLabel = (spec: number): string => `SPEC-${String(spec).padStart(2, '0')}`;

// The spec numbers ticked in START.md: at least one ticked line starts with the spec, and no
// unticked one does (a spec may be built in parts across milestones).
export function tickedSpecs(startText: string): Set<number> {
  const ticked = new Set<number>();
  const unticked = new Set<number>();
  for (const match of startText.matchAll(/^\s*-\s*\[([ xX])\]\s+SPEC-(\d{2})\b/gm)) {
    const spec = Number(match[2]);
    if (match[1] === ' ') unticked.add(spec);
    else ticked.add(spec);
  }
  for (const spec of unticked) ticked.delete(spec);
  return ticked;
}

type RowOutcome = { readonly row: GuaranteeRow; readonly entry: GuaranteeEntry; readonly shownClass: string; readonly problem: string | undefined };

function judgeRow(row: GuaranteeRow, entry: GuaranteeEntry, results: TestResults, ticked: ReadonlySet<number>): RowOutcome {
  const test = entry.testId === null ? undefined : results.tests.get(entry.testId);
  const proven = test !== undefined && test.passed;
  const pendingSpecs = entry.pendingUntilSpecs;
  const pendingNote = pendingSpecs === undefined ? '' : ` (pending ${pendingSpecs.map(specLabel).join(', ')})`;
  const shownClass = proven ? entry.provenClass : `${entry.weakerClass}${pendingNote}`;
  let problem: string | undefined;
  if (pendingSpecs !== undefined && pendingSpecs.every((spec) => ticked.has(spec))) {
    problem = `${row} is marked pending until ${pendingSpecs.map(specLabel).join(', ')}, which START.md ticks; map the test that proves it and drop the mark`;
  } else if (pendingSpecs === undefined && entry.testId === null) {
    problem = `${row} has no test`;
  } else if (pendingSpecs === undefined && test === undefined) {
    problem = `${row}: its test ${entry.testId ?? ''} is in no result of this run`;
  } else if (pendingSpecs === undefined && test !== undefined && failed(test)) {
    problem = `${row}: its test ${test.testId} failed`;
  } else if (pendingSpecs === undefined && !proven) {
    problem = `${row}: its test ${entry.testId ?? ''} did not pass (skipped)`;
  }
  return { row, entry, shownClass, problem };
}

const tableCell = (text: string): string => text.replace(/\|/g, '\\|');

export function guaranteeTable(outcomes: readonly RowOutcome[]): string {
  return [
    '# Guarantees',
    '',
    'Each phase-1 guarantee, the class a green CI run shows for it, and the test that proves it. Generated by',
    '`node tools/guarantee-map.ts --write` from a green run; CI fails when this file differs from what a run generates.',
    '',
    '| Guarantee | Class | Proven by |',
    '|---|---|---|',
    ...outcomes.map((outcome) => `| \`${outcome.row}\` | ${tableCell(outcome.shownClass)} | ${outcome.entry.testId === null ? 'no test yet' : `\`${tableCell(outcome.entry.testId)}\``} |`),
    '',
    'Disclosed, not tested in phase 1: that a plan is semantically right and that AI judgements are right (statistical);',
    'that prompt injection is prevented (not achievable); HTTP and identity allow-lists, retries and tokens (phase 2).',
    '',
  ].join('\n');
}

export function checkGuarantees(root: string, map: GuaranteeMap = GUARANTEE_MAP): { readonly table: string; readonly problems: readonly string[] } {
  const results = readTestResults(root);
  const startPath = join(root, 'START.md');
  const ticked = tickedSpecs(existsSync(startPath) ? readFileSync(startPath, 'utf8') : '');
  const rows = Object.keys(map).filter((row): row is GuaranteeRow => Object.hasOwn(map, row));
  const outcomes = rows.map((row) => judgeRow(row, map[row], results, ticked));
  const table = guaranteeTable(outcomes);
  const problems = outcomes.flatMap((outcome) => (outcome.problem === undefined ? [] : [outcome.problem]));
  if (results.files.length === 0) problems.unshift(`no test results in ${RESULTS_FOLDER}/; run the tests first`);
  const publishedPath = join(root, PUBLISHED_TABLE);
  const published = existsSync(publishedPath) ? readFileSync(publishedPath, 'utf8') : undefined;
  if (published !== table) {
    problems.push(`${PUBLISHED_TABLE} differs from what this run generates; after a green run, regenerate it with node tools/guarantee-map.ts --write`);
  }
  return { table, problems };
}

function main(words: readonly string[]): number {
  const root = process.cwd();
  const { table, problems } = checkGuarantees(root);
  mkdirSync(join(root, RESULTS_FOLDER), { recursive: true });
  writeFileSync(join(root, RESULTS_FOLDER, RUN_TABLE), table);
  if (words.includes('--write')) {
    const blocking = problems.filter((problem) => !problem.startsWith(PUBLISHED_TABLE));
    if (blocking.length > 0) {
      for (const problem of blocking) console.error(`guarantee map: ${problem}`);
      console.error(`guarantee map: ${PUBLISHED_TABLE} is written only from a green run`);
      return 1;
    }
    writeFileSync(join(root, PUBLISHED_TABLE), table);
    console.log(`wrote ${PUBLISHED_TABLE}`);
    return 0;
  }
  for (const problem of problems) console.error(`guarantee map: ${problem}`);
  console.log(problems.length === 0 ? 'guarantee map passed' : `guarantee map failed: ${problems.length} problem(s)`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
