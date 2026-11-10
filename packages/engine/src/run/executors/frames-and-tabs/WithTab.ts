// A second tab as a scope: opened, used, and always closed, so no caller can forget the close.
import {
    success,
    type DriverError,
    type Result,
    type Session,
    type SessionTab,
} from "@revisum/contracts";

// Opens the URL in a second tab of the session, hands the tab to `use` and closes it however `use`
// ends. A tab's close never rejects: the session's close reports what went wrong with it.
export async function withTab<Used>(
    session: Session,
    url: string,
    use: (tab: SessionTab) => Promise<Used>,
): Promise<Result<Used, DriverError>> {
    const opened = await session.newTab(url);
    if (!opened.ok) {
        return opened;
    }
    const tab = opened.value;
    try {
        return success(await use(tab));
    } finally {
        await tab.close();
    }
}
