import type { DownloadedFile, DriverError, Result } from "@revisum/contracts";

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
    // cancelled and its bytes deleted; a kept file stays until the session closes.
    release(shouldKeep: boolean): Promise<void>;
}
