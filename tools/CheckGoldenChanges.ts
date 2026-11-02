// The golden freeze. Goldens prove the code still does what it did, so from FREEZE_COMMIT on a
// commit may change them only to fix a recorded defect. Such a commit names the defect in a
// `Defect: <number>` trailer, and the number has a row in docs/decisions/refactor-defects.md.
// Checks each commit of a pushed range on its own, in the repository of the working folder:
//   node tools/CheckGoldenChanges.ts --commits <from>..<to>
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trailerBlock } from "./check-commit-trailers.ts";
import { matchesAny } from "./glob.ts";

// The golden reset's commit. It stays null until the main session sets it; until then nothing is
// frozen, and the reset itself is free to change the goldens.
const FREEZE_COMMIT: string | null = "5a7d0dc35c63c114a6f89e7fb4e4ec7024ed6502";

const GOLDEN_FILES = ["golden/**"];
const DEFECT_TRAILER_KEY = "Defect";
const DEFECT_NUMBER = /^\d+$/;
const DEFECT_ROW = /^\|\s*(\d+)\s*\|/gm;
const DEFECT_LOG = join("docs", "decisions", "refactor-defects.md");

// The number of every row in the defect log's table.
export function readDefectNumbers(defectLog: string): ReadonlySet<string> {
    return new Set([...defectLog.matchAll(DEFECT_ROW)].flatMap((row) => row[1] ?? []));
}

// Why a commit's message doesn't allow it to change a golden, or null when it does. At least one
// trailer must name a row, and none may name a row that doesn't exist.
export function defectTrailerProblem(
    message: string,
    defectNumbers: ReadonlySet<string>,
): string | null {
    const named = trailerBlock(message)
        .filter((trailer) => trailer.key === DEFECT_TRAILER_KEY)
        .map((trailer) => trailer.value);
    if (named.length === 0) {
        return `it has no "${DEFECT_TRAILER_KEY}: <number>" trailer`;
    }
    const unknown = named.filter(
        (value) => !DEFECT_NUMBER.test(value) || !defectNumbers.has(value),
    );
    if (unknown.length > 0) {
        return `its trailer names no row in ${DEFECT_LOG}: ${unknown.join(", ")}`;
    }
    return null;
}

// Every problem in the range's commits after the freeze, oldest first, in the repository at `root`.
// A merge's list holds only what the merge itself changed: the commits it brings in are in the
// range and judged on their own. A freeze commit Git doesn't know stops the check with an error.
export function checkGoldenChanges(
    range: string,
    freezeCommit: string,
    root: string,
): readonly string[] {
    const git = (...words: readonly string[]): string =>
        execFileSync("git", words, { cwd: root, encoding: "utf8" });
    const defectNumbers = readDefectNumbers(readFileSync(join(root, DEFECT_LOG), "utf8"));
    const commits = git("rev-list", "--reverse", range, `^${freezeCommit}`)
        .split("\n")
        .filter((commit) => commit !== "");
    return commits.flatMap((commit) => {
        const changed = git(
            "diff-tree",
            "--root",
            "--no-commit-id",
            "--name-only",
            "--no-renames",
            "-r",
            "-c",
            "-z",
            commit,
        );
        const goldens = changed.split("\0").filter((path) => matchesAny(path, GOLDEN_FILES));
        if (goldens.length === 0) {
            return [];
        }
        const problem = defectTrailerProblem(
            git("log", "-1", "--format=%B", commit),
            defectNumbers,
        );
        if (problem === null) {
            return [];
        }
        return [`commit ${commit.slice(0, 12)} changes ${goldens.join(", ")}, but ${problem}`];
    });
}

function main(words: readonly string[]): number {
    const flag = words.indexOf("--commits");
    const range = flag === -1 ? undefined : words[flag + 1];
    if (range === undefined || !range.includes("..")) {
        console.error("usage: node tools/CheckGoldenChanges.ts --commits <from>..<to>");
        return 2;
    }
    if (FREEZE_COMMIT === null) {
        console.log("golden changes passed: no freeze commit is set yet");
        return 0;
    }
    const problems = checkGoldenChanges(range, FREEZE_COMMIT, process.cwd());
    for (const problem of problems) {
        console.error(`golden changes: ${problem}`);
    }
    console.log(
        problems.length === 0
            ? `golden changes passed: no commit in ${range} changes a golden without naming a defect`
            : `golden changes failed: ${problems.length} commit(s)`,
    );
    return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
    process.exitCode = main(process.argv.slice(2));
}
