// What a session learns from the browser about its page outside any one command.
export interface PageEvents {
    // True once the page's renderer or browser has died, its target has closed, or the connection to
    // the browser has closed.
    crashed(): boolean;
    // The text of the dialog the page has open, or null when none is open.
    openDialog(): string | null;
    // Accepts or dismisses the open dialog.
    answerDialog(shouldAccept: boolean): Promise<void>;
    // Resolves once the top document is not on its way to another, or a dialog or a crash has stopped
    // it from getting there: at once when it is not.
    navigationEnded(): Promise<void>;
    // What the browser refused of the driver's decisions on the session's requests, in any of its tabs,
    // each with its reason, and each request it held that the driver could not read to decide on.
    refusedRequestDecisions(): readonly string[];
    // Grows with each popup, second page and download the page starts. Each is closed or cancelled as
    // soon as it starts. Only growth means anything: a download counts as its file is asked for, and
    // again as it begins.
    unsupportedOpenings(): number;
}
