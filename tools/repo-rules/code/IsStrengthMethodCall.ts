// Recognises an approval's strength tested through a method rather than a comparison, which decides a
// result by strength just the same: `approval.strength.startsWith('verif')`,
// `['verified'].includes(approval.strength)` or `new Set(strengths).has(approval.strength)`.
import type { Token } from "../naming/LintRepository.ts";
import { closingParenthesis, isIdentifier, isPunctuator } from "../ListSourceFiles.ts";
import { TokenKind } from "../naming/LintRepository.ts";

const STRING_TESTS = new Set([
    "startsWith",
    "endsWith",
    "includes",
    "indexOf",
    "lastIndexOf",
    "match",
    "search",
    "localeCompare",
]);
const MEMBERSHIP_TESTS = new Set(["includes", "indexOf", "lastIndexOf", "has"]);

// The first token of the property read that ends at `end`, as in `this.approval?.strength`.
export function propertyReadStart(tokens: readonly Token[], end: number): number {
    let start = end;
    while (isPunctuator(tokens[start - 1], ".")) {
        const hasMark =
            isPunctuator(tokens[start - 2], "?") || isPunctuator(tokens[start - 2], "!");
        start -= hasMark ? 3 : 2;
    }
    return start;
}

// True when the expression ending at `end` reads a strength: a `strength` property or variable, or
// a local that holds one.
const isStrengthRead = (
    tokens: readonly Token[],
    end: number,
    isStrengthLocalAt: (position: number) => boolean,
): boolean =>
    isIdentifier(tokens[end], "strength") ||
    (!isPunctuator(tokens[end - 1], ".") && isStrengthLocalAt(end));

// True when the call whose "(" is at `open` has one argument, and that argument reads a strength.
function isStrengthTheOnlyArgument(
    tokens: readonly Token[],
    open: number,
    isStrengthLocalAt: (position: number) => boolean,
): boolean {
    const close = closingParenthesis(tokens, open);
    const last = isPunctuator(tokens[close - 1], ",") ? close - 2 : close - 1;
    return (
        last > open &&
        propertyReadStart(tokens, last) === open + 1 &&
        isStrengthRead(tokens, last, isStrengthLocalAt)
    );
}

// True when the identifier at `index` is a method called on a strength, or asked about one.
export function isStrengthMethodCall(
    tokens: readonly Token[],
    index: number,
    isStrengthLocalAt: (position: number) => boolean,
): boolean {
    const method = tokens[index];
    if (
        method?.kind !== TokenKind.Identifier ||
        !isPunctuator(tokens[index - 1], ".") ||
        !isPunctuator(tokens[index + 1], "(")
    ) {
        return false;
    }
    const hasMark = isPunctuator(tokens[index - 2], "?") || isPunctuator(tokens[index - 2], "!");
    const receiverEnd = index - (hasMark ? 3 : 2);
    return (
        (STRING_TESTS.has(method.text) && isStrengthRead(tokens, receiverEnd, isStrengthLocalAt)) ||
        (MEMBERSHIP_TESTS.has(method.text) &&
            isStrengthTheOnlyArgument(tokens, index + 1, isStrengthLocalAt))
    );
}
