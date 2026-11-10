// The glossary's Standard names table must say what the naming lint's standardNames says.
import { NAMING_LINT } from "../naming/NamingLint.ts";

export function standardNamesProblems(tableRows: readonly (readonly string[])[]): string[] {
    const listed = new Map(tableRows.map((cells) => [cells[0] ?? "", cells[1] ?? ""]));
    const problems: string[] = [];
    for (const [acronym, fullName] of Object.entries(NAMING_LINT.standardNames)) {
        const given = listed.get(acronym);
        if (given === undefined) {
            problems.push(
                `the standard name ${acronym} (${fullName}) is missing from the Standard names table`,
            );
        } else if (given !== fullName) {
            problems.push(
                `the standard name ${acronym} is "${given}" in the glossary, but "${fullName}" in tools/repo-rules/naming/NamingLint.ts`,
            );
        }
    }
    for (const acronym of listed.keys()) {
        if (!Object.hasOwn(NAMING_LINT.standardNames, acronym)) {
            problems.push(
                `the Standard names table lists ${acronym}, which tools/repo-rules/naming/NamingLint.ts does not`,
            );
        }
    }
    return problems;
}
