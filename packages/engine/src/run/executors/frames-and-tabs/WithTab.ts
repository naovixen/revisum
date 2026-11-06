// A second tab as a scope: opened, used, and always closed, so no caller can forget the close.
import {
    failure,
    success,
    type DriverError,
    type Result,
    type Session,
    type SessionTab,
    type StepCode,
} from "@revisum/contracts";
import type { Logger } from "../../../logging.ts";
import { codeForThrow } from "../../CodeForThrow.ts";

// What using a tab gave, and how its close went: the code of a close that failed, whose detail the
// log holds.
export type UsedTab<Used> = { readonly used: Used; readonly closed: Result<void, StepCode> };

// The port's close rejects when it fails; this says so as an outcome.
async function closeTab(tab: SessionTab, logger: Logger): Promise<Result<void, StepCode>> {
    try {
        await tab.close();
        return success(undefined);
    } catch (error) {
        return failure(codeForThrow(error, tab, logger));
    }
}

// Opens the URL in a second tab of the session, hands the tab to `use` and closes it however `use`
// ends. When `use` throws, the throw goes on once the tab is closed, and a close that failed as well
// is in the log.
export async function withTab<Used>(
    session: Session,
    url: string,
    logger: Logger,
    use: (tab: SessionTab) => Promise<Used>,
): Promise<Result<UsedTab<Used>, DriverError>> {
    const opened = await session.newTab(url);
    if (!opened.ok) {
        return opened;
    }
    const tab = opened.value;
    let used: Used;
    try {
        used = await use(tab);
    } catch (error) {
        await closeTab(tab, logger);
        throw error;
    }
    return success({ used, closed: await closeTab(tab, logger) });
}
