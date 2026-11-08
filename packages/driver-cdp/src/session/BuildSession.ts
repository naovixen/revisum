// Turns any protocol's PageOperations into a Session. Auto-waiting, the runtime guard, probing,
// masking and auditing live in this folder once, so every protocol behaves the same way.
import {
    failure,
    NavigateScripts,
    success,
    type DriverError,
    type Result,
    type SessionEnvironment,
    type SessionTab,
} from "@revisum/contracts";
import { hitChecks } from "../page/HitChecks.ts";
import type { PageFunction } from "../page/PageFunction.ts";
import type { PageWithInput } from "../page/PageOperations.ts";
import { documentPorts } from "./DocumentPorts.ts";
import type { DriverSession } from "./DriverSession.ts";
import type { SessionDetails, TabDetails } from "./SessionDetails.ts";
import { CRASHED } from "./WaitUntilActionable.ts";

// Opens a second tab and loads the URL in it. A tab whose page does not load is closed at once.
async function newTabAt(
    openTab: () => Promise<Result<SessionTab, DriverError>>,
    url: string,
    crashed: () => boolean,
): Promise<Result<SessionTab, DriverError>> {
    const opened = await openTab();
    if (!opened.ok) {
        return crashed() ? failure(CRASHED) : opened;
    }
    const tab = opened.value;
    const navigated = await tab.navigate(url, { scripts: NavigateScripts.Enabled });
    if (navigated.ok) {
        return success(tab);
    }
    // Why the tab could not load is the step's failure. A tab that also fails to close is for the
    // session's close to report: a tab's close never rejects.
    await tab.close();
    return navigated;
}

// One tab of a session: its document's ports, and its own close.
export function buildTab<Handle>(
    operations: PageWithInput<Handle>,
    environment: SessionEnvironment,
    details: TabDetails,
): SessionTab {
    return {
        ...documentPorts(operations, hitChecks(operations), [operations], environment, details),
        close: details.close,
    };
}

export function buildSession<Handle>(
    operations: PageWithInput<Handle>,
    environment: SessionEnvironment,
    details: SessionDetails,
): DriverSession {
    return {
        ...documentPorts(operations, hitChecks(operations), [operations], environment, details),
        close: details.close,
        newTab: (url: string) => newTabAt(details.openTab, url, () => details.events.crashed()),
        network: details.network,
        storage: details.storage,
        clock: details.clock,
        clipboard: details.clipboard,
        browser: details.browser,
        processId: details.processId,
        isRequestHeld: () => details.events.refusedRequestDecisions().length > 0,
        recordsSoFar: details.recordsSoFar,
        egressRecords: details.egressRecords,
        evaluate: (pageFunction: PageFunction, inputs = []) =>
            operations.callForStringInMainWorld(pageFunction, inputs),
    };
}
