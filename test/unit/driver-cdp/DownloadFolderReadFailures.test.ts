// What is in a session's download folder decides whether a file passed its limit and whether its bytes
// have gone. A folder that has gone holds nothing, so reading it as empty is right. A folder that cannot
// be read says nothing about what is in it: it must not read as a file of zero bytes, or let a discarded
// download's bytes stay without a word.
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { describe, test, type TestContext } from "node:test";
import { DownloadFolder } from "../../../packages/driver-cdp/src/capabilities/DownloadFolder.ts";
import type { BrowserCommand } from "../../../packages/driver-cdp/src/connection/BrowserCommand.ts";
import type { BrowserEvent } from "../../../packages/driver-cdp/src/connection/BrowserEvent.ts";
import { CdpConnection } from "../../../packages/driver-cdp/src/connection/CdpConnection.ts";

const DOWNLOAD = {
    downloadId: "the-download",
    frameId: "the-frame",
    url: "http://127.0.0.1:1/report.pdf",
    suggestedFilename: "report.pdf",
};
const MAXIMUM_BYTES = 1024;
const BEGIN_TIMEOUT_MILLISECONDS = 5000;

const WHY_THE_FOLDER_CANNOT_BE_READ = "EPERM: operation not permitted, scandir";
const FOLDER_GONE_CODE = "ENOENT";

const readFailure = (message: string, code: string): Error =>
    Object.assign(new Error(message), { code });

// A connection that answers every command and tells the folder of the progress a test gives it.
class ConnectionForDownloads extends CdpConnection {
    readonly #onProgress = new Map<string, (raw: unknown) => void>();

    constructor() {
        super(new EventTarget() as unknown as WebSocket, 1000);
    }

    override ask<CommandParameters, Reply>(
        sessionId: string | undefined,
        command: BrowserCommand<CommandParameters, Reply>,
    ): Promise<Reply> {
        return Promise.resolve(command.decode({}));
    }

    override listen<Payload>(
        sessionId: string | undefined,
        event: BrowserEvent<Payload>,
        handler: (payload: Payload) => void,
    ): () => void {
        this.#onProgress.set(event.name, (raw) => {
            const decoded = event.decode(raw);
            if (decoded.ok) {
                handler(decoded.value);
            }
        });
        return () => undefined;
    }

    reportProgress(state: "inProgress" | "canceled"): void {
        this.#onProgress.get("Browser.downloadProgress")?.({
            guid: DOWNLOAD.downloadId,
            receivedBytes: 0,
            state,
        });
    }
}

type ArmedFolder = {
    readonly folder: DownloadFolder;
    readonly connection: ConnectionForDownloads;
    readonly armed: ReturnType<DownloadFolder["arm"]>;
};

// A download step that has claimed the download its press began.
async function armedWithClaimedDownload(): Promise<ArmedFolder> {
    const connection = new ConnectionForDownloads();
    const folder = new DownloadFolder(connection, "the-browser-context");
    const armed = folder.arm();
    await armed.expectFromPress({ frameId: DOWNLOAD.frameId, canStartFile: true });
    assert.equal(folder.claims(DOWNLOAD), true);
    return { folder, connection, armed };
}

// Runs `action` while listing any folder fails with this error, then restores the real thing.
async function withFolderListingThat<Answer>(
    context: TestContext,
    error: Error,
    action: () => Promise<Answer>,
): Promise<Answer> {
    const failing = context.mock.method(fs, "readdirSync", () => {
        throw error;
    });
    syncBuiltinESMExports();
    try {
        return await action();
    } finally {
        failing.mock.restore();
        syncBuiltinESMExports();
    }
}

describe("Using the session's download folder", () => {
    describe("given a download still in progress", () => {
        describe("and a folder that cannot be read", () => {
            describe("when the step waits for its file", () => {
                test("then it should fail for the folder, not as a file with no bytes", async (context) => {
                    const { folder, armed } = await armedWithClaimedDownload();
                    let looks = 0;
                    const shouldStopWaiting = (): boolean => {
                        looks += 1;
                        return looks > 1;
                    };
                    const finished = await withFolderListingThat(
                        context,
                        readFailure(WHY_THE_FOLDER_CANNOT_BE_READ, "EPERM"),
                        () =>
                            armed
                                .finish(
                                    MAXIMUM_BYTES,
                                    BEGIN_TIMEOUT_MILLISECONDS,
                                    shouldStopWaiting,
                                )
                                .catch((error: unknown) => ({
                                    ok: false as const,
                                    error: { code: "rejected", detail: String(error) },
                                })),
                    );
                    await armed.release(false);
                    folder.remove();
                    assert.ok(!finished.ok, "the step does not pass");
                    assert.doesNotMatch(
                        finished.error.detail,
                        /started no download/,
                        "a folder that cannot be read is no download that never began",
                    );
                });
            });
        });
    });

    describe("given a download the step discards", () => {
        describe("and a folder that cannot be read", () => {
            describe("when the step releases it", () => {
                test("then it should reject rather than quietly keep the bytes", async (context) => {
                    const { folder, connection, armed } = await armedWithClaimedDownload();
                    connection.reportProgress("canceled");
                    await withFolderListingThat(
                        context,
                        readFailure(WHY_THE_FOLDER_CANNOT_BE_READ, "EPERM"),
                        () => assert.rejects(armed.release(false)),
                    );
                    folder.remove();
                });
            });
        });

        describe("and a folder that has gone", () => {
            describe("when the step releases it", () => {
                test("then it should resolve, as nothing is left of its bytes", async (context) => {
                    const { folder, connection, armed } = await armedWithClaimedDownload();
                    connection.reportProgress("canceled");
                    await withFolderListingThat(
                        context,
                        readFailure("ENOENT: no such file or directory", FOLDER_GONE_CODE),
                        () => armed.release(false),
                    );
                    folder.remove();
                });
            });
        });
    });
});
