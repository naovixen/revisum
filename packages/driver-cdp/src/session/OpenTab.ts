// A second tab in the session's own browser context, so it shares cookies and storage.
import {
    DriverErrorCode,
    failure,
    success,
    type DriverError,
    type Result,
    type SessionTab,
} from "@revisum/contracts";
import { CLOSE_TARGET, CREATE_TARGET } from "../connection/BrowserCommand.ts";
import { RUN_IF_WAITING_FOR_DEBUGGER } from "../connection/domains/RuntimeDomain.ts";
import { errorText } from "../connection/ErrorText.ts";
import { CdpPage } from "../page/CdpPage.ts";
import type { AttachedPage } from "../page/PageOpenings.ts";
import type { PageWatch } from "../page/PageWatch.ts";
import { buildTab } from "./BuildSession.ts";
import type { SessionBrowser } from "./SessionBrowser.ts";
import type { DocumentDetails } from "./SessionDetails.ts";
import { startPage, watchPageOf } from "./StartPage.ts";

// How long a new tab is given to attach after the browser creates it.
const TAB_ATTACH_TIMEOUT_MILLISECONDS = 10_000;

// The first page's watch hands the tab over still paused; it is prepared exactly as the first page
// was, then let run on about:blank. Closing it closes only the tab.
export async function openTab(
    browser: SessionBrowser,
    firstWatch: PageWatch,
    firstDetails: DocumentDetails,
): Promise<Result<SessionTab, DriverError>> {
    const { connection, browserContextId } = browser;
    const attaching = firstWatch.nextTab(TAB_ATTACH_TIMEOUT_MILLISECONDS);
    let attached: AttachedPage;
    try {
        await connection.ask(undefined, CREATE_TARGET, { url: "about:blank", browserContextId });
        attached = await attaching.promise;
    } catch (error) {
        attaching.cancel();
        return failure({
            code: DriverErrorCode.NavigationFailed,
            detail: `the new tab did not open: ${errorText(error)}`,
        });
    }
    const watch = watchPageOf(browser, attached, false);
    const stops: (() => void)[] = [];
    // Never rejects: what stops a tab closing is for the session's close to report, and must not take
    // the place of what a step found.
    const close = async (): Promise<void> => {
        watch.markClosedByDriver();
        browser.openPages.delete(watch);
        watch.stop();
        for (const stop of stops) {
            stop();
        }
        await connection
            .ask(undefined, CLOSE_TARGET, { targetId: attached.targetId })
            .catch((error: unknown) => {
                watch.noteTargetFailure("a tab could not be closed", error);
            });
    };
    browser.openPages.add(watch);
    try {
        await startPage(browser, attached.sessionId, watch, stops);
        await connection.ask(attached.sessionId, RUN_IF_WAITING_FOR_DEBUGGER, {});
    } catch (error) {
        await close();
        return failure({
            code: DriverErrorCode.NavigationFailed,
            detail: `the new tab could not be prepared: ${errorText(error)}`,
        });
    }
    return success(
        buildTab(CdpPage.topDocument(connection, attached.sessionId, watch), browser.environment, {
            fixturePath: firstDetails.fixturePath,
            downloads: browser.downloadCapture,
            events: watch,
            close,
            secretTypedFields: firstDetails.secretTypedFields,
        }),
    );
}
