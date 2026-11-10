// What every page of one session shares.
import type { SessionEnvironment, Target } from "@revisum/contracts";
import type { BrowserClock } from "../capabilities/BrowserClock.ts";
import type { BrowserNetwork } from "../capabilities/BrowserNetwork.ts";
import type { DownloadCapture } from "../capabilities/DownloadCapture.ts";
import type { DownloadFolder } from "../capabilities/DownloadFolder.ts";
import type { EgressRecorder } from "../capabilities/EgressRecorder.ts";
import type { CdpConnection } from "../connection/CdpConnection.ts";
import type { PageWatch, SessionFailures } from "../page/PageWatch.ts";
import { isAllowedUrl } from "./IsAllowedUrl.ts";

// The browser's own context, the target and environment it emulates, the egress allow-list's record
// of blocked origins, the egress recorder, the download folder, the stubs and request checks, which
// reach every tab, the run's virtual clock, and what has gone wrong outside any one command.
export type SessionBrowser = {
    readonly connection: CdpConnection;
    readonly browserContextId: string;
    readonly userAgent: string;
    readonly target: Target;
    readonly environment: SessionEnvironment;
    readonly blocked: string[];
    readonly recorder: EgressRecorder;
    readonly downloads: DownloadFolder;
    // The folder, as a session's steps use it: what fails letting a download go goes to `failures`.
    readonly downloadCapture: DownloadCapture;
    readonly network: BrowserNetwork;
    readonly clock: BrowserClock;
    readonly failures: SessionFailures;
    // The watch of every page of the session still open, the first page's and each open tab's,
    // which the session's close ends.
    readonly openPages: Set<PageWatch>;
};

// A held-back popup never loads, so it is always recorded as a request that went nowhere. Only an
// undeclared address is a refusal of the origin: a run may well reach a declared one in its own tab.
export function recordPopupRequest(browser: SessionBrowser, requestedUrl: string): void {
    const url = URL.parse(requestedUrl);
    if (url !== null && !isAllowedUrl(url, browser.environment.allowedOrigins)) {
        browser.recorder.recordUndeclaredPopup(requestedUrl);
        browser.blocked.push(url.origin);
        return;
    }
    browser.recorder.record(requestedUrl, "popup");
}
