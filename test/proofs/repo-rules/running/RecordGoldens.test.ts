// The replay golden records the host and the browser executable's hash, so only the kind of machine
// it was made on may remake it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { replayGoldenRefusal } from "../../../../tools/test-runner/RecordGoldens.ts";

describe("Using the goldens recorder", () => {
    describe("given Windows on x64", () => {
        describe("when it asks whether it may remake the replay golden", () => {
            test("then it should not refuse", () => {
                assert.equal(replayGoldenRefusal({ platform: "win32", arch: "x64" }), null);
            });
        });
    });

    for (const host of [
        { platform: "linux", arch: "x64" },
        { platform: "win32", arch: "arm64" },
        { platform: "darwin", arch: "arm64" },
    ]) {
        describe(`given ${host.platform} on ${host.arch}`, () => {
            describe("when it asks whether it may remake the replay golden", () => {
                test("then it should refuse, naming the host and saying why", () => {
                    const refusal = replayGoldenRefusal(host) ?? assert.fail("it did not refuse");
                    assert.ok(refusal.includes(`${host.platform}/${host.arch}`), refusal);
                    assert.ok(refusal.includes("browser executable's hash"), refusal);
                });
            });
        });
    }
});
