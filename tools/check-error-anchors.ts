// Every error code has a docs anchor: docs/errors.md holds one "## <code>" heading per code of
// every closed error-code union, so the link errors#<code> resolves. This check reads the codes
// from the unions' declarations and fails, naming the code, when a heading is missing, or when a
// heading names a code that no union holds any more.
// See docs/specs/SPEC-27-shared-types-and-events.md.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Token } from './lint-names.ts';
import { codeTokens, isIdentifier, isPunctuator } from './source-files.ts';
import { reportProblems } from './workspace-packages.ts';

export const ERRORS_PAGE = 'docs/errors.md';

// Each error-code union: the file that declares it and the declared name. The codes are the string
// literals in the declaration, whether a union type or a const list.
export const ERROR_CODE_UNIONS: readonly { readonly file: string; readonly name: string }[] = [
  { file: 'packages/engine/src/plan/plan-decoders.ts', name: 'PLAN_ERROR_CODES' },
  { file: 'packages/engine/src/run-values.ts', name: 'StepErrorCode' },
  { file: 'packages/contracts/src/browser-driver.ts', name: 'DriverErrorCode' },
  { file: 'packages/contracts/src/error-codes.ts', name: 'RunnerError' },
  { file: 'packages/contracts/src/error-codes.ts', name: 'RecorderError' },
  { file: 'packages/contracts/src/audit-events.ts', name: 'SinkError' },
  { file: 'packages/contracts/src/error-codes.ts', name: 'CliErrorCode' },
  { file: 'packages/contracts/src/approval.ts', name: 'ApprovalErrorCode' },
  { file: 'packages/contracts/src/approval.ts', name: 'TrustError' },
  { file: 'packages/contracts/src/policy.ts', name: 'PolicyRuleId' },
  { file: 'packages/engine/src/lifecycle.ts', name: 'RefusalCode' },
];

// The string literals from `type Name =` or `const Name =` up to the ";" that ends the declaration.
function declaredCodes(tokens: readonly Token[], name: string): string[] | undefined {
  const start = tokens.findIndex((token, index) =>
    isIdentifier(token, name) && (isIdentifier(tokens[index - 1], 'type') || isIdentifier(tokens[index - 1], 'const'))
    && isPunctuator(tokens[index + 1], '='));
  if (start === -1) return undefined;
  const codes: string[] = [];
  let depth = 0;
  for (const token of tokens.slice(start + 2)) {
    if (isPunctuator(token, '{') || isPunctuator(token, '[') || isPunctuator(token, '(')) depth += 1;
    else if (isPunctuator(token, '}') || isPunctuator(token, ']') || isPunctuator(token, ')')) depth -= 1;
    else if (isPunctuator(token, ';') && depth === 0) break;
    else if (token.kind === 'string') codes.push(token.text);
  }
  return codes;
}

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
    const declared = existsSync(filePath) ? declaredCodes(codeTokens(readFileSync(filePath, 'utf8')), union.name) : undefined;
    if (declared === undefined || declared.length === 0) {
      problems.push(`cannot read the codes of ${union.name} from ${union.file}; update ERROR_CODE_UNIONS in tools/check-error-anchors.ts`);
      continue;
    }
    for (const code of declared) {
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
