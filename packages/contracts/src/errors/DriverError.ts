// Why a driver could not do what a step asked.
// policy-denied: the policy gate's runtime guard refused the action, so no input event was sent.
// no-download: a download step's click started no download within the step timeout.
// download-too-large: the file grew past the project's maximumDownloadBytes; its partial bytes are deleted.
// storage-origin-mismatch: a storage write's page is not on the entry's declared origin, so nothing was written.
// clock-runaway: one clock advance would fire more timer callbacks than the project's maximumTimersPerAdvance.
// clipboard-unavailable: the browser cannot keep the clipboard in its own memory, so it is never read.
// target-crashed: the page's renderer died, its target closed, the browser died or the connection
// to it closed, while the step ran. The step fails, the rest of the run is skipped, and close()
// still ends every process.
// unsupported-step: the step made the page open a popup or a second page, or start a download no
// download step claimed: the popup is closed and the download cancelled, with nothing of it kept, so
// the step never passes with a partial result. Or the step asks what a document cannot do: an iframe
// whose document runs in another process, or scripts turned off inside a frame.
// assertion-failed: a dialog step's expected text is not the open dialog's text, so nothing
// answered the dialog.
// selector-invalid: the browser rejects a CSS selector or XPath expression the step's locator
// holds, or the XPath expression selects no nodes at all (such as count()), so nothing was sent.
// script-failed: a page script threw, its promise rejected, or its source is not one function.
// script-timeout: a page script did not settle within its timeout.
// script-result-invalid: a page script's result is not JSON: undefined, a function, or a cyclic value.
// page-unreadable: a read of the page threw or got no answer in time, so nothing is known of it.
// dialog-open: a dialog holds the page, so a step could not act on it or read it. Only a dialog step can free it.
export const DriverErrorCode = {
    NotFound: "not-found",
    Ambiguous: "ambiguous",
    NotActionable: "not-actionable",
    Timeout: "timeout",
    NavigationFailed: "navigation-failed",
    PolicyDenied: "policy-denied",
    NoDownload: "no-download",
    DownloadTooLarge: "download-too-large",
    StorageOriginMismatch: "storage-origin-mismatch",
    ClockRunaway: "clock-runaway",
    ClipboardUnavailable: "clipboard-unavailable",
    TargetCrashed: "target-crashed",
    UnsupportedStep: "unsupported-step",
    AssertionFailed: "assertion-failed",
    SelectorInvalid: "selector-invalid",
    ScriptFailed: "script-failed",
    ScriptTimeout: "script-timeout",
    ScriptResultInvalid: "script-result-invalid",
    PageUnreadable: "page-unreadable",
    DialogOpen: "dialog-open",
} as const;
export type DriverErrorCode = (typeof DriverErrorCode)[keyof typeof DriverErrorCode];
export type DriverError = { readonly code: DriverErrorCode; readonly detail: string };
