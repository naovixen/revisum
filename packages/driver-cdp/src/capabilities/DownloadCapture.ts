import type { DownloadedFile, DriverError, Result } from "@revisum/contracts";
import { errorText } from "../connection/ErrorText.ts";

// The browser's downloads for one session and its tabs: saved into a folder of the session's own,
// and refused at every other time.
export interface DownloadCapture {
    // Holds the session's downloads for one step. Nothing is saved or claimed until expectFromPress.
    arm(): ArmedDownload;
}
// What a download step knows about the press it is about to send.
export type DownloadPress = {
    // The frame the press acts in. A file that begins in another frame is not the press's.
    readonly frameId: string;
    // False when the press can start nothing, so no file can be the press's.
    readonly canStartFile: boolean;
};
export interface ArmedDownload {
    // Called just before the press: lets the browser save the next download of the press's frame,
    // and claims it for the caller. A download that began earlier is no download of the press. Called
    // again when the press was aimed anew and not sent, and then only this latest aim counts.
    expectFromPress(press: DownloadPress): Promise<void>;
    // Waits up to `beginTimeoutMilliseconds` for the claimed download to start (no-download), then
    // for its last byte. A file over `maximumBytes` is cancelled and its bytes deleted
    // (download-too-large). Stops waiting as soon as `shouldStopWaiting` says the step is over.
    // Rejects when the session's folder cannot be read, which no outcome here can say.
    finish(
        maximumBytes: number,
        beginTimeoutMilliseconds: number,
        shouldStopWaiting: () => boolean,
    ): Promise<Result<DownloadedFile, DriverError>>;
    // Refuses downloads again. Unless `shouldKeep` is true and the file finished, the download is
    // cancelled and its bytes deleted; a kept file stays until the session closes. Rejects with what
    // it could not do: reportingReleaseFailures keeps that from a step, whose outcome it must not touch.
    release(shouldKeep: boolean): Promise<void>;
}

// A capture whose release never rejects: what stopped it is told to `noteFailure` instead, for the
// session's close to report, since a clean-up that failed says nothing of what a step found.
export function reportingReleaseFailures(
    capture: DownloadCapture,
    noteFailure: (failure: string) => void,
): DownloadCapture {
    return {
        arm: () => {
            const armed = capture.arm();
            return {
                ...armed,
                release: async (shouldKeep) => {
                    try {
                        await armed.release(shouldKeep);
                    } catch (error) {
                        noteFailure(`a download could not be let go: ${errorText(error)}`);
                    }
                },
            };
        },
    };
}
