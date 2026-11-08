// Opens a session in a browser the driver has attached: its own browser context, its first page,
// and everything the session's pages share.
import {
    failure,
    mergeRefusedOrigins,
    success,
    type ClosedSession,
    type Result,
    type SessionEnvironment,
    type SessionRecords,
    type Target,
} from "@revisum/contracts";
import { BrowserClock } from "../capabilities/BrowserClock.ts";
import { BrowserNetwork } from "../capabilities/BrowserNetwork.ts";
import { DownloadFolder } from "../capabilities/DownloadFolder.ts";
import { EgressRecorder } from "../capabilities/EgressRecorder.ts";
import { fixtureFilePath, readFixture } from "../capabilities/FixtureFilePath.ts";
import { PageStorage } from "../capabilities/PageStorage.ts";
import {
    RunClipboard,
    SHARED_BROWSER_CLIPBOARD,
    allowRunClipboard,
} from "../capabilities/RunClipboard.ts";
import type { OpenedSessionEgress } from "../capabilities/SessionEgress.ts";
import {
    ATTACH_TO_TARGET,
    CREATE_BROWSER_CONTEXT,
    CREATE_TARGET,
    GET_VERSION,
} from "../connection/BrowserCommand.ts";
import { errorText } from "../connection/ErrorText.ts";
import type { AttachedBrowser } from "../launch/SharedBrowser.ts";
import { CdpPage } from "../page/CdpPage.ts";
import { holdUnreadableEvent, type PageWatch, type SessionFailures } from "../page/PageWatch.ts";
import { buildSession } from "./BuildSession.ts";
import { closeInTurn } from "./CloseInTurn.ts";
import type { DriverSession } from "./DriverSession.ts";
import { openTab } from "./OpenTab.ts";
import type { SessionBrowser } from "./SessionBrowser.ts";
import type { SessionDetails } from "./SessionDetails.ts";
import { startPage, watchPageOf } from "./StartPage.ts";

export async function createSession(
    attached: AttachedBrowser,
    sessionEgress: OpenedSessionEgress,
    target: Target,
    environment: SessionEnvironment,
    fixturesFolder: string | undefined,
): Promise<DriverSession> {
    const connection = attached.connection;
    const version = await connection.ask(undefined, GET_VERSION, {});
    const { browserContextId } = await connection.ask(undefined, CREATE_BROWSER_CONTEXT, {
        disposeOnDetach: true,
        ...sessionEgress.contextProxy,
    });
    const { targetId } = await connection.ask(undefined, CREATE_TARGET, {
        url: "about:blank",
        browserContextId,
    });
    const { sessionId } = await connection.ask(undefined, ATTACH_TO_TARGET, {
        targetId,
        flatten: true,
    });
    const browser = sessionBrowserOf(attached, browserContextId, version.userAgent, {
        target,
        environment,
        fixturesFolder,
    });
    await allowRunClipboard(connection, browserContextId);
    const watch = watchPageOf(browser, { targetId, sessionId }, true);
    browser.openPages.add(watch);
    await startPage(browser, sessionId, watch, []);
    const recordsSoFar = (): SessionRecords => sessionRecordsOf(browser, sessionEgress, watch);
    let closing: Promise<ClosedSession> | undefined;
    const details: SessionDetails = {
        browser: {
            name: "chromium",
            version: /\/(\S+)$/.exec(version.product)?.[1] ?? version.product,
        },
        processId: attached.processId,
        egressRecords: () => browser.recorder.records(),
        recordsSoFar,
        close: () => {
            closing ??= closeSession(browser, attached, sessionEgress, watch, recordsSoFar);
            return closing;
        },
        events: watch,
        fixturePath: (fixture) => fixtureFilePath(fixturesFolder, fixture),
        downloads: browser.downloads,
        secretTypedFields: [],
        openTab: () => openTab(browser, watch, details),
        network: browser.network,
        storage: new PageStorage(
            (command, parameters) => watch.askRunningPage(command, parameters),
            () => watch.crashed(),
        ),
        clock: browser.clock,
        clipboard: attached.isShared
            ? SHARED_BROWSER_CLIPBOARD
            : new RunClipboard(
                  connection,
                  browserContextId,
                  (command, parameters) => watch.askRunningPage(command, parameters),
                  () => watch.crashed(),
              ),
    };
    return buildSession(CdpPage.topDocument(connection, sessionId, watch), environment, details);
}

type SessionSettings = {
    readonly target: Target;
    readonly environment: SessionEnvironment;
    readonly fixturesFolder: string | undefined;
};

function sessionBrowserOf(
    attached: AttachedBrowser,
    browserContextId: string,
    userAgent: string,
    settings: SessionSettings,
): SessionBrowser {
    const connection = attached.connection;
    const failures: SessionFailures = { refusedDecisions: [], cleanUp: [] };
    // Every request's origin and channel, for the run's egress events.
    const recorder = new EgressRecorder(connection, failures);
    return {
        connection,
        browserContextId,
        userAgent,
        target: settings.target,
        environment: settings.environment,
        blocked: [],
        recorder,
        downloads: new DownloadFolder(connection, browserContextId),
        network: new BrowserNetwork(connection, {
            readFixture: (fixture) => readFixture(settings.fixturesFolder, fixture),
            onAnsweredInBrowser: (requestId) => {
                recorder.answeredInBrowser(requestId);
            },
            onMalformedEvent: holdUnreadableEvent(failures),
        }),
        clock: new BrowserClock(settings.environment.virtualTimers === true),
        failures,
        openPages: new Set(),
    };
}

// Popups settle first, so the blocked origins are complete once this ends. The first page's watch
// sees every popup of the browser context, whichever tab opened it. The download folder goes once
// the browser can no longer write into it. A shared browser that keeps the session's context rejects
// here, and the folder stays for the same reason. The egress goes last, whatever happened, since
// nothing else ends it. Clean-up failures are read while the session still runs: closing fails
// whatever was still waiting for an answer, which says nothing about it. Every page still open ends
// with the session, however the browser went. The records are read once all of that has ended.
async function closeSession(
    browser: SessionBrowser,
    attached: AttachedBrowser,
    sessionEgress: OpenedSessionEgress,
    firstPage: PageWatch,
    recordsSoFar: () => SessionRecords,
): Promise<ClosedSession> {
    const closeFailure = await closeInTurn([
        () => firstPage.settleHeldPopupsAndReportCleanUp(),
        async () => {
            await attached.close();
            browser.downloads.remove();
        },
        () => sessionEgress.egress.close(),
        () => {
            endOpenPages(browser.openPages);
            return Promise.resolve();
        },
    ]);
    return { ...recordsSoFar(), closeFailure };
}

// What the session has noted, each record read on its own: the egress is handed in and can fail to
// say what it refused, which says nothing about the other records.
function sessionRecordsOf(
    browser: SessionBrowser,
    sessionEgress: OpenedSessionEgress,
    firstPage: PageWatch,
): SessionRecords {
    const { egress } = sessionEgress;
    return {
        blockedOrigins: readOrSayWhy(() =>
            mergeRefusedOrigins(browser.blocked, egress.refusedOrigins()),
        ),
        connectionFailures: readOrSayWhy(() => egress.connectionFailures()),
        refusedRequestDecisions: readOrSayWhy(() => firstPage.refusedRequestDecisions()),
    };
}

function readOrSayWhy<Value>(read: () => Value): Result<Value, string> {
    try {
        return success(read());
    } catch (error) {
        return failure(errorText(error));
    }
}

function endOpenPages(openPages: Set<PageWatch>): void {
    for (const page of openPages) {
        page.endWithSession();
    }
    openPages.clear();
}
