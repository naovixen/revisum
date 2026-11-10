// The two hashes of a run result, worked out here from the result's own fields, so a test can compare
// them exactly, and can recompute them the way anyone checking a stored result would. The result hash
// leaves out the blocked origins, which a request sent as a run ends can change; the evidence hash covers
// them, so an edit to that list stays detectable. Neither covers the timings, the manifest body, which
// the manifest's own hash covers, or the hashes themselves.
import assert from "node:assert/strict";
import { canonicalJson, sha256 } from "@revisum/engine";

const LEFT_OUT_OF_BOTH: readonly string[] = ["timings", "manifest", "resultHash", "evidenceHash"];

const hashWithout = (result: object, leftOut: readonly string[]): string =>
    sha256(
        canonicalJson(
            Object.fromEntries(
                Object.entries(result).filter(([field]) => !leftOut.includes(field)),
            ),
        ),
    );

export const expectedResultHash = (result: object): string =>
    hashWithout(result, [...LEFT_OUT_OF_BOTH, "blockedOrigins"]);

export const expectedEvidenceHash = (result: object): string =>
    hashWithout(result, LEFT_OUT_OF_BOTH);

// Read by name, so that a result without the field fails the one test that asks for it, naming the
// field, rather than stopping the whole test run from compiling.
export function evidenceHashOf(result: object): string {
    const evidenceHash: unknown = Reflect.get(result, "evidenceHash");
    if (typeof evidenceHash !== "string") {
        assert.fail(`the result has no evidence hash: ${JSON.stringify(result)}`);
    }
    return evidenceHash;
}

// A result as a file holds it: what anyone checking it later has to go on.
export const storedCopy = (result: object): object => {
    const stored: unknown = JSON.parse(JSON.stringify(result));
    assert.ok(typeof stored === "object" && stored !== null, "the result is not an object");
    return stored;
};
