// A download capture a test decides the answers of, and which keeps what its release was told.
import { failure, type DownloadedFile, type DriverError, type Result } from "@revisum/engine";
import type {
    ArmedDownload,
    DownloadCapture,
} from "../../../packages/driver-cdp/src/capabilities/DownloadCapture.ts";

export const FAKE_DOWNLOADED_FILE: DownloadedFile = {
    fileName: "report.txt",
    mediaType: "text/plain",
    bytes: new Uint8Array([104, 105]),
    sha256: "the-sha256-of-the-file",
};

const NO_FILE: Result<DownloadedFile, DriverError> = failure({
    code: "no-download",
    detail: "the fake page starts no download",
});

export type WatchedDownloadCapture = {
    readonly capture: DownloadCapture;
    // What each release was told about keeping the file, in order.
    readonly releases: readonly boolean[];
};

export function fakeDownloadCapture(changes: Partial<ArmedDownload> = {}): WatchedDownloadCapture {
    const releases: boolean[] = [];
    const armed: ArmedDownload = {
        expectFromPress: () => Promise.resolve(),
        finish: () => Promise.resolve(NO_FILE),
        release: (shouldKeep) => {
            releases.push(shouldKeep);
            return Promise.resolve();
        },
        ...changes,
    };
    return { capture: { arm: () => armed }, releases };
}
