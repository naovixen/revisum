// The two hashes of a run result, made the same way for plan runs and evidence runs. Neither is keyed:
// anyone can recompute them, so an edit to a result shows only against a copy of the hash held elsewhere.
import { canonicalJson, sha256 } from "./hashing.ts";
import type { RunResult } from "./run.ts";

// Timings differ from run to run, and the manifest's hash stands in for its body.
const LEFT_OUT_OF_BOTH: readonly (keyof RunResult)[] = [
    "timings",
    "manifest",
    "resultHash",
    "evidenceHash",
];

// A request a page sends as a run ends races the session's close, so two runs of one plan can refuse
// different origins. Replay compares the result hash, which must not depend on that race.
const LEFT_OUT_OF_RESULT_HASH: readonly (keyof RunResult)[] = [
    ...LEFT_OUT_OF_BOTH,
    "blockedOrigins",
];

const hashWithout = (result: object, leftOut: readonly string[]): string =>
    sha256(
        canonicalJson(
            Object.fromEntries(
                Object.entries(result).filter(([field]) => !leftOut.includes(field)),
            ),
        ),
    );

export function withRunHashes(result: Omit<RunResult, "resultHash" | "evidenceHash">): RunResult {
    return {
        ...result,
        resultHash: hashWithout(result, LEFT_OUT_OF_RESULT_HASH),
        evidenceHash: hashWithout(result, LEFT_OUT_OF_BOTH),
    };
}
