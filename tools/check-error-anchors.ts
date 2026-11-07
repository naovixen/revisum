// Every error code has a docs anchor: docs/errors.md holds one "## <code>" heading per code of
// every closed error-code union, so the link errors#<code> resolves. This check reads the codes
// from the unions' declarations and fails, naming the code, when a heading is missing, or when a
// heading names a code that no union holds any more.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Token } from './lint-names.ts';
import { codeTokens, isIdentifier, isPunctuator } from './source-files.ts';
import { reportProblems } from './workspace-packages.ts';

export const ERRORS_PAGE = 'docs/errors.md';

// Each error-code union: the file that declares it and the declared name. The codes are the string
// literals in the declaration, whether a union type or a const list.
export const ERROR_CODE_UNIONS: readonly { readonly file: string; readonly name: string }[] = [
  { file: 'packages/contracts/src/run-result/PlanError.ts', name: 'PlanErrorCode' },
  { file: 'packages/engine/src/plan/readable/text-syntax.ts', name: 'TextErrorCode' },
  // StepErrorCode takes its codes from StepCode, every code a step's result can hold.
  { file: 'packages/contracts/src/foundation/StepCode.ts', name: 'StepCode' },
  { file: 'packages/engine/src/run-values.ts', name: 'StepErrorCode' },
  { file: 'packages/contracts/src/run-result/SuiteDecodeError.ts', name: 'SuiteDecodeErrorCode' },
  { file: 'packages/contracts/src/browser-driver.ts', name: 'DriverErrorCode' },
  // RunnerErrorCode and WorkloadErrorCode share these, and CliErrorCode these build-fetch codes.
  { file: 'packages/contracts/src/isolated-runner.ts', name: 'ContainerRefusalCode' },
  { file: 'packages/contracts/src/browser-driver.ts', name: 'BuildFetchFailureCode' },
  { file: 'packages/contracts/src/error-codes.ts', name: 'RunnerErrorCode' },
  { file: 'packages/runner/src/egress-policy.ts', name: 'EgressPolicyError' },
  { file: 'packages/runner/src/run-image.ts', name: 'RunImageError' },
  { file: 'packages/contracts/src/error-codes.ts', name: 'RecorderErrorCode' },
  { file: 'packages/contracts/src/audit-events.ts', name: 'SinkErrorCode' },
  // CliErrorCode adds its own codes to ExploreErrorCode's, so both are read.
  { file: 'packages/contracts/src/explore-mode.ts', name: 'ExploreErrorCode' },
  { file: 'packages/contracts/src/error-codes.ts', name: 'CliErrorCode' },
  { file: 'packages/contracts/src/approval.ts', name: 'ApprovalErrorCode' },
  { file: 'packages/contracts/src/approval.ts', name: 'TrustErrorCode' },
  { file: 'packages/contracts/src/policy.ts', name: 'PolicyRuleId' },
  { file: 'packages/contracts/src/run-result/Refusal.ts', name: 'RefusalCode' },
  { file: 'packages/contracts/src/workload.ts', name: 'WorkloadErrorCode' },
  { file: 'packages/contracts/src/run-result/EvidenceOutcomeCode.ts', name: 'EvidenceOutcomeCode' },
  // RunReviewItemCode adds its own codes to UnreadRecordCode's, and borrows one each from
  // ServiceCallErrorCode and EvidenceOutcomeCode.
  { file: 'packages/contracts/src/run-result/RunReviewItem.ts', name: 'UnreadRecordCode' },
  { file: 'packages/contracts/src/run-result/RunReviewItem.ts', name: 'RunReviewItemCode' },
  // Why a declared target cannot run: a TargetUnavailable result's reason.
  { file: 'packages/contracts/src/browser-driver.ts', name: 'UnavailableReason' },
  { file: 'packages/engine/src/manifest.ts', name: 'ReplayErrorCode' },
  // ServiceCallErrorCode adds its own codes to ResponseReadErrorCode's, so both are read.
  { file: 'packages/contracts/src/service-calls.ts', name: 'ResponseReadErrorCode' },
  { file: 'packages/contracts/src/service-calls.ts', name: 'ServiceCallErrorCode' },
];

// What a declaration holds: its own codes, and the sets whose codes it takes by name, which only
// those sets' own entries can show.
export type DeclaredCodes = { readonly codes: readonly string[]; readonly borrowedSets: readonly string[] };

// True for the Set in `...Set`, `Set.Member`, `Key: Set,` and `| Set`.
function namesBorrowedSet(tokens: readonly Token[], index: number): boolean {
  const before = tokens[index - 1];
  const after = tokens[index + 1];
  if (isPunctuator(before, '.')) {
    return isPunctuator(tokens[index - 2], '.') && isPunctuator(tokens[index - 3], '.');
  }
  return isPunctuator(after, '.') || isPunctuator(before, '|') || isPunctuator(before, '=')
    || (isPunctuator(before, ':') && (isPunctuator(after, ',') || isPunctuator(after, '}')));
}

// The string literals from `type Name =` or `const Name =` up to the ";" that ends the declaration,
// and the sets it names on the way.
export function readDeclaredCodes(tokens: readonly Token[], name: string): DeclaredCodes | undefined {
  const start = tokens.findIndex((token, index) =>
    isIdentifier(token, name) && (isIdentifier(tokens[index - 1], 'type') || isIdentifier(tokens[index - 1], 'const'))
    && isPunctuator(tokens[index + 1], '='));
  if (start === -1) return undefined;
  const codes: string[] = [];
  const borrowedSets = new Set<string>();
  let depth = 0;
  for (let index = start + 2; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === undefined) {
      break;
    }
    if (isPunctuator(token, '{') || isPunctuator(token, '[') || isPunctuator(token, '(')) depth += 1;
    else if (isPunctuator(token, '}') || isPunctuator(token, ']') || isPunctuator(token, ')')) depth -= 1;
    else if (isPunctuator(token, ';') && depth === 0) break;
    else if (token.kind === 'string') codes.push(token.text);
    // `typeof Set.Member` names the set, not `typeof`.
    else if (token.kind === 'identifier' && token.text !== 'typeof' && namesBorrowedSet(tokens, index)) {
      borrowedSets.add(token.text);
    }
  }
  return { codes, borrowedSets: [...borrowedSets] };
}

// The sets a declaration borrows codes from that the check does not read, so their codes go unchecked.
export const unlistedBorrowedSets = (declared: DeclaredCodes, listedNames: readonly string[]): readonly string[] =>
  declared.borrowedSets.filter((set) => !listedNames.includes(set));

const headingsIn = (text: string): Set<string> =>
  new Set(text.split(/\r?\n/).flatMap((line) => {
    const heading = /^##\s+(\S+)\s*$/.exec(line);
    return heading?.[1] === undefined ? [] : [heading[1]];
  }));

export function checkErrorAnchors(root: string): string[] {
  const problems: string[] = [];
  const codes = new Set<string>();
  const pagePath = join(root, ERRORS_PAGE);
  const headings = existsSync(pagePath) ? headingsIn(readFileSync(pagePath, 'utf8')) : new Set<string>();
  if (!existsSync(pagePath)) problems.push(`${ERRORS_PAGE} is missing`);

  for (const union of ERROR_CODE_UNIONS) {
    const filePath = join(root, union.file);
    const declared = existsSync(filePath) ? readDeclaredCodes(codeTokens(readFileSync(filePath, 'utf8')), union.name) : undefined;
    if (declared === undefined || (declared.codes.length === 0 && declared.borrowedSets.length === 0)) {
      problems.push(`cannot read the codes of ${union.name} from ${union.file}; update ERROR_CODE_UNIONS in tools/check-error-anchors.ts`);
      continue;
    }
    for (const set of unlistedBorrowedSets(declared, ERROR_CODE_UNIONS.map((listed) => listed.name))) {
      problems.push(`${union.name} in ${union.file} takes codes from ${set}, which ERROR_CODE_UNIONS does not list, so they go unchecked; add ${set} to tools/check-error-anchors.ts`);
    }
    for (const code of declared.codes) {
      codes.add(code);
      if (!headings.has(code)) problems.push(`${ERRORS_PAGE} has no "## ${code}" heading, so errors#${code} does not resolve (${union.name} in ${union.file})`);
    }
  }
  for (const heading of headings) {
    if (!codes.has(heading)) problems.push(`${ERRORS_PAGE} has a "## ${heading}" heading, but no error-code union holds ${heading}`);
  }
  return problems;
}

if (import.meta.main) process.exitCode = reportProblems('error anchor check', checkErrorAnchors(process.cwd()));
