import type { DownloadName } from "../plan.ts";

// What a run keeps of a downloaded file. The server's name and media type are kept redacted; the
// content is never kept (until privacy masking, whatever evidence.keepDownloads says).
export type DownloadRecord = {
    readonly downloadName: DownloadName;
    readonly fileName: string;
    readonly mediaType: string;
    readonly size: number;
    readonly sha256: string;
};
