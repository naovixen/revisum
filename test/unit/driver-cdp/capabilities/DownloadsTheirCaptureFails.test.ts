// A download step's port promises a Result. What goes wrong with the capture of the file is that
// step's failure, stated as one: a rejection is no outcome a run can read.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { success, type DownloadedFile, type DriverError, type Result } from "@revisum/engine";
import { testId } from "#test-support/browser/RawPlan.ts";
import { fakeDocumentPorts } from "#test-support/fakes/session/FakeDocumentPorts.ts";
import {
    FAKE_DOWNLOADED_FILE,
    fakeDownloadCapture,
    type WatchedDownloadCapture,
} from "#test-support/fakes/session/FakeDownloadCapture.ts";
import { elementPageOperations } from "#test-support/fakes/session/ElementPageOperations.ts";
import { allowing, downloadStep } from "#test-support/session-contract/SessionUnderTest.ts";

const WHY = "the download folder could not be read";
const MAXIMUM_BYTES = 1024;

const downloadWith = (
    capture: WatchedDownloadCapture["capture"],
): Promise<Result<DownloadedFile, DriverError>> =>
    fakeDocumentPorts({ operations: elementPageOperations(), downloads: capture }).download(
        downloadStep(testId("report")),
        MAXIMUM_BYTES,
        allowing().guard,
    );

const CAPTURE_FAILURES: readonly {
    readonly name: string;
    readonly capture: () => WatchedDownloadCapture;
    readonly releases: readonly boolean[];
}[] = [
    {
        name: "whose finish rejects",
        capture: () => fakeDownloadCapture({ finish: () => Promise.reject(new Error(WHY)) }),
        releases: [false],
    },
    {
        name: "that cannot be armed",
        capture: () => ({
            ...fakeDownloadCapture(),
            capture: {
                arm: () => {
                    throw new Error(WHY);
                },
            },
        }),
        releases: [],
    },
];

describe("Using a download step", () => {
    for (const { name, capture, releases } of CAPTURE_FAILURES) {
        describe(`given a capture ${name}`, () => {
            describe("when the step runs", () => {
                test("then it should give a failed Result, not a rejection", async () => {
                    const watched = capture();
                    const outcome = await downloadWith(watched.capture);
                    assert.equal(outcome.ok, false, JSON.stringify(outcome));
                    assert.deepEqual(watched.releases, releases);
                });
            });
        });
    }

    describe("given a capture that finishes with a file", () => {
        describe("when the step runs", () => {
            test("then it should give the file, and release it to be kept", async () => {
                const watched = fakeDownloadCapture({
                    finish: () => Promise.resolve(success(FAKE_DOWNLOADED_FILE)),
                });
                const outcome = await downloadWith(watched.capture);
                assert.deepEqual(outcome, success(FAKE_DOWNLOADED_FILE));
                assert.deepEqual(watched.releases, [true]);
            });
        });
    });
});
