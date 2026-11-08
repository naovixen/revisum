// Starts watching a page of the session and prepares it, before it loads anything.
import { ENABLE_PAGE } from "../connection/BrowserCommand.ts";
import { PageWatch, type AttachedPage } from "../page/PageWatch.ts";
import { preparePage } from "./PreparePage.ts";
import { recordPopupRequest, type SessionBrowser } from "./SessionBrowser.ts";

// The watch of a page of the session. The first page's sets up what the whole browser context
// shares; a tab's leaves it be.
export function watchPageOf(
    browser: SessionBrowser,
    page: AttachedPage,
    isFirstPage: boolean,
): PageWatch {
    return new PageWatch(
        browser.connection,
        { browserContextId: browser.browserContextId, ...page },
        {
            failures: browser.failures,
            onPopupRequest: (url) => {
                recordPopupRequest(browser, url);
            },
            ownsBrowserContext: isFirstPage,
            claimsDownload: (begun) => browser.downloads.claims(begun),
            isDownloadStepUnderWay: () => browser.downloads.isArmed(),
        },
    );
}

// Watches the page, records its requests, holds its stubs, response bodies and clock, and prepares
// it. Each way to stop what it started joins `stops` as soon as it has started, so whatever the
// caller ends after a failure part way is all that began.
export async function startPage(
    browser: SessionBrowser,
    sessionId: string,
    watch: PageWatch,
    stops: (() => void)[],
): Promise<void> {
    await browser.connection.ask(sessionId, ENABLE_PAGE, {});
    await watch.start();
    await browser.recorder.start(sessionId);
    stops.push(await browser.network.watchPage(sessionId));
    stops.push(browser.downloads.watchResponses(sessionId));
    await preparePage(browser, sessionId, watch);
    stops.push(
        await browser.clock.watchPage(
            (command, parameters) => watch.ask(command, parameters),
            () => watch.crashed(),
        ),
    );
}
