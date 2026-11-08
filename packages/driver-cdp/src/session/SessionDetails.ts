// What a protocol hands buildSession (BuildSession.ts) besides its document's operations.
import type {
    BrowserRequestRecord,
    ClipboardPort,
    ClockPort,
    ClosedSession,
    DriverError,
    NetworkPort,
    ResolvedLocator,
    Result,
    SessionRecords,
    SessionTab,
    StoragePort,
} from "@revisum/contracts";
import type { DownloadCapture } from "../capabilities/DownloadCapture.ts";
import type { PageEvents } from "../page/PageEvents.ts";

// A field a secret was typed into: the locator that found it, and whether that very element has gone.
export type SecretTypedField = {
    readonly locator: ResolvedLocator;
    readonly isGone: () => Promise<boolean>;
};

// What every document of a tab, the first one included, is made of.
export type DocumentDetails = {
    readonly events: PageEvents;
    // The absolute path of a declared upload fixture, or why it cannot be sent.
    readonly fixturePath: (fixture: string) => Result<string, DriverError>;
    // Where a download step's file is saved.
    readonly downloads: DownloadCapture;
    // Every field the session and its tabs have typed a secret into, in the order they were typed.
    readonly secretTypedFields: SecretTypedField[];
};

// A second tab: its documents, and its own close, which never rejects.
export type TabDetails = DocumentDetails & { readonly close: () => Promise<void> };

export type SessionDetails = DocumentDetails & {
    readonly browser: { readonly name: string; readonly version: string };
    readonly processId: number;
    // Ends the session and gives what it leaves, never rejecting.
    readonly close: () => Promise<ClosedSession>;
    readonly recordsSoFar: () => SessionRecords;
    // Every request's origin and the channel it left the browser by.
    readonly egressRecords: () => readonly BrowserRequestRecord[];
    // Opens a second tab of the session's browser context, still on about:blank.
    readonly openTab: () => Promise<Result<SessionTab, DriverError>>;
    // Stubs and request checks for the whole browser context.
    readonly network: NetworkPort;
    // The page's local and session storage.
    readonly storage: StoragePort;
    // The session's virtual clock, shared by every tab.
    readonly clock: ClockPort;
    // The browser's own clipboard.
    readonly clipboard: ClipboardPort;
};
