// Every error code has a docs anchor: docs/errors.md holds one "## <code>" heading per code of
// every closed error-code union, so the link errors#<code> resolves. This check reads the codes
// from the unions' declarations and fails, naming the code, when a heading is missing, or when a
// heading names a code that no union holds any more.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Token } from "../naming/LintRepository.ts";
import { codeTokens, isIdentifier, isPunctuator } from "../ListSourceFiles.ts";
import { reportProblems } from "../ReadWorkspacePackages.ts";
import { TokenKind } from "../naming/LintRepository.ts";

export const ERRORS_PAGE = "docs/errors.md";

// Each error-code union: the file that declares it and the declared name. The codes are the string
// literals in the declaration, whether a union type or a const list.
export const ERROR_CODE_UNIONS: readonly { readonly file: string; readonly name: string }[] = [
    { file: "packages/contracts/src/run-result/refusals/PlanError.ts", name: "PlanErrorCode" },
    { file: "packages/engine/src/plan/readable/Syntax.ts", name: "TextErrorCode" },
    // StepErrorCode takes its codes from StepCode, every code a step's result can hold.
    { file: "packages/contracts/src/foundation/StepCode.ts", name: "StepCode" },
    { file: "packages/engine/src/run/values/RunValues.ts", name: "StepErrorCode" },
    {
        file: "packages/contracts/src/run-result/refusals/SuiteDecodeError.ts",
        name: "SuiteDecodeErrorCode",
    },
    { file: "packages/contracts/src/errors/DriverError.ts", name: "DriverErrorCode" },
    // RunnerErrorCode and WorkloadErrorCode share these, and CliErrorCode these build-fetch codes.
    { file: "packages/contracts/src/errors/ContainerRefusalCode.ts", name: "ContainerRefusalCode" },
    { file: "packages/contracts/src/ports/BrowserDriver.ts", name: "BuildFetchFailureCode" },
    { file: "packages/contracts/src/errors/RunnerError.ts", name: "RunnerErrorCode" },
    { file: "packages/runner/src/egress/BuildEgressPolicy.ts", name: "EgressPolicyError" },
    { file: "packages/runner/src/image/RunImage.ts", name: "RunImageError" },
    { file: "packages/contracts/src/errors/RunnerError.ts", name: "RecorderErrorCode" },
    { file: "packages/contracts/src/events/AuditEventKind.ts", name: "SinkErrorCode" },
    // CliErrorCode adds its own codes to ExploreErrorCode's, so both are read.
    { file: "packages/contracts/src/modes/PageMap.ts", name: "ExploreErrorCode" },
    { file: "packages/contracts/src/errors/CliErrorCode.ts", name: "CliErrorCode" },
    { file: "packages/contracts/src/ports/Approval.ts", name: "ApprovalErrorCode" },
    { file: "packages/contracts/src/ports/Approval.ts", name: "TrustErrorCode" },
    { file: "packages/contracts/src/ports/PolicyRuleId.ts", name: "PolicyRuleId" },
    { file: "packages/contracts/src/run-result/refusals/Refusal.ts", name: "RefusalCode" },
    { file: "packages/contracts/src/ports/WorkloadRunner.ts", name: "WorkloadErrorCode" },
    {
        file: "packages/contracts/src/run-result/EvidenceOutcomeCode.ts",
        name: "EvidenceOutcomeCode",
    },
    // RunReviewItemCode adds its own codes to UnreadRecordCode's, and borrows one each from
    // ServiceCallErrorCode and EvidenceOutcomeCode.
    { file: "packages/contracts/src/run-result/RunReviewItem.ts", name: "UnreadRecordCode" },
    { file: "packages/contracts/src/run-result/RunReviewItem.ts", name: "RunReviewItemCode" },
    // Why a declared target cannot run: a TargetUnavailable result's reason.
    { file: "packages/contracts/src/ports/BrowserDriver.ts", name: "UnavailableReason" },
    { file: "packages/engine/src/run/seal/BuildManifest.ts", name: "ReplayErrorCode" },
    // ServiceCallErrorCode adds its own codes to ResponseReadErrorCode's, so both are read.
    { file: "packages/contracts/src/plan/steps/ServiceCaller.ts", name: "ResponseReadErrorCode" },
    { file: "packages/contracts/src/plan/steps/ServiceCaller.ts", name: "ServiceCallErrorCode" },
];

// What a declaration holds: its own codes, and the sets whose codes it takes by name, which only
// those sets' own entries can show.
export type DeclaredCodes = {
    readonly codes: readonly string[];
    readonly borrowedSets: readonly string[];
};

// True for the Set in `...Set`, `Set.Member`, `Key: Set,` and `| Set`.
function namesBorrowedSet(tokens: readonly Token[], index: number): boolean {
    const before = tokens[index - 1];
    const after = tokens[index + 1];
    if (isPunctuator(before, ".")) {
        return isPunctuator(tokens[index - 2], ".") && isPunctuator(tokens[index - 3], ".");
    }
    return (
        isPunctuator(after, ".") ||
        isPunctuator(before, "|") ||
        isPunctuator(before, "=") ||
        (isPunctuator(before, ":") && (isPunctuator(after, ",") || isPunctuator(after, "}")))
    );
}

// True for the Moved in `{ Own: 'own', Moved }`, a member named with no value of its own.
const isShorthandMember = (tokens: readonly Token[], index: number): boolean =>
    (isPunctuator(tokens[index - 1], "{") || isPunctuator(tokens[index - 1], ",")) &&
    (isPunctuator(tokens[index + 1], ",") || isPunctuator(tokens[index + 1], "}"));

// True for the string in `{ 'key': value }`, which names a member and is no code.
const isQuotedKey = (tokens: readonly Token[], index: number): boolean =>
    isPunctuator(tokens[index + 1], ":") &&
    (isPunctuator(tokens[index - 1], "{") ||
        isPunctuator(tokens[index - 1], ",") ||
        isPunctuator(tokens[index - 1], ";"));

const declaresNameWith = (tokens: readonly Token[], name: string, keyword: string): number =>
    tokens.findIndex(
        (token, index) =>
            isIdentifier(token, name) &&
            isIdentifier(tokens[index - 1], keyword) &&
            isPunctuator(tokens[index + 1], "="),
    );

// The string literals from `const Name =` or `type Name =` up to the ";" that ends the declaration,
// and the sets it names on the way. A name with both is read at its const: the type only restates
// the object's values, whichever comes first in the file.
export function readDeclaredCodes(
    tokens: readonly Token[],
    name: string,
): DeclaredCodes | undefined {
    const constantStart = declaresNameWith(tokens, name, "const");
    const isConstant = constantStart !== -1;
    const start = isConstant ? constantStart : declaresNameWith(tokens, name, "type");
    if (start === -1) {
        return undefined;
    }
    const codes: string[] = [];
    const borrowedSets = new Set<string>();
    const openBrackets: Token[] = [];
    for (let index = start + 2; index < tokens.length; index++) {
        const token = tokens[index];
        if (token === undefined) {
            break;
        }
        const isDirectlyInBraces = isPunctuator(openBrackets.at(-1), "{");
        if (isPunctuator(token, "{") || isPunctuator(token, "[") || isPunctuator(token, "(")) {
            openBrackets.push(token);
        } else if (
            isPunctuator(token, "}") ||
            isPunctuator(token, "]") ||
            isPunctuator(token, ")")
        ) {
            openBrackets.pop();
        } else if (isPunctuator(token, ";") && openBrackets.length === 0) {
            break;
        } else if (token.kind === TokenKind.String) {
            if (!(isDirectlyInBraces && isQuotedKey(tokens, index))) {
                codes.push(token.text);
            }
        }
        // `typeof Set.Member` names the set, not `typeof`. A field's type inside a type literal says
        // what the field holds, and adds no codes to the set.
        else if (
            token.kind === TokenKind.Identifier &&
            token.text !== "typeof" &&
            (isConstant || !openBrackets.some((bracket) => isPunctuator(bracket, "{"))) &&
            (namesBorrowedSet(tokens, index) ||
                (isConstant && isDirectlyInBraces && isShorthandMember(tokens, index)))
        ) {
            borrowedSets.add(token.text);
        }
    }
    return { codes, borrowedSets: [...borrowedSets] };
}

// The sets a declaration borrows codes from that the check does not read, so their codes go unchecked.
export const unlistedBorrowedSets = (
    declared: DeclaredCodes,
    listedNames: readonly string[],
): readonly string[] => declared.borrowedSets.filter((set) => !listedNames.includes(set));

const headingsIn = (text: string): Set<string> =>
    new Set(
        text.split(/\r?\n/).flatMap((line) => {
            const heading = /^##\s+(\S+)\s*$/.exec(line);
            return heading?.[1] === undefined ? [] : [heading[1]];
        }),
    );

export function checkErrorAnchors(root: string): string[] {
    const problems: string[] = [];
    const codes = new Set<string>();
    const pagePath = join(root, ERRORS_PAGE);
    const headings = existsSync(pagePath)
        ? headingsIn(readFileSync(pagePath, "utf8"))
        : new Set<string>();
    if (!existsSync(pagePath)) {
        problems.push(`${ERRORS_PAGE} is missing`);
    }

    for (const union of ERROR_CODE_UNIONS) {
        const filePath = join(root, union.file);
        const declared = existsSync(filePath)
            ? readDeclaredCodes(codeTokens(readFileSync(filePath, "utf8")), union.name)
            : undefined;
        if (
            declared === undefined ||
            (declared.codes.length === 0 && declared.borrowedSets.length === 0)
        ) {
            problems.push(
                `cannot read the codes of ${union.name} from ${union.file}; update ERROR_CODE_UNIONS in tools/repo-rules/docs/CheckErrorAnchors.ts`,
            );
            continue;
        }
        for (const set of unlistedBorrowedSets(
            declared,
            ERROR_CODE_UNIONS.map((listed) => listed.name),
        )) {
            problems.push(
                `${union.name} in ${union.file} takes codes from ${set}, which ERROR_CODE_UNIONS does not list, so they go unchecked; add ${set} to tools/repo-rules/docs/CheckErrorAnchors.ts`,
            );
        }
        for (const code of declared.codes) {
            codes.add(code);
            if (!headings.has(code)) {
                problems.push(
                    `${ERRORS_PAGE} has no "## ${code}" heading, so errors#${code} does not resolve (${union.name} in ${union.file})`,
                );
            }
        }
    }
    for (const heading of headings) {
        if (!codes.has(heading)) {
            problems.push(
                `${ERRORS_PAGE} has a "## ${heading}" heading, but no error-code union holds ${heading}`,
            );
        }
    }
    return problems;
}

if (import.meta.main) {
    process.exitCode = reportProblems("error anchor check", checkErrorAnchors(process.cwd()));
}
