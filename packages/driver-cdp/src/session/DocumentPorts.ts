// The ports of one document: the top document of a tab, or an iframe's document inside it.
import {
    failure,
    success,
    type DocumentSession,
    type DriverError,
    type NavigateOptions,
    type ResolvedLocator,
    type Result,
    type SessionEnvironment,
} from "@revisum/contracts";
import { errorText } from "../connection/ErrorText.ts";
import type { CheckedDocument, HitChecks } from "../page/HitChecks.ts";
import type { PageOperations } from "../page/PageOperations.ts";
import { actOnDocument } from "./ActOnDocument.ts";
import {
    failureOfRefusedDecision,
    failureOfThrow,
    inputSettled,
    isTopDocument,
    readOfPage,
    SELECTOR_INVALID,
    type DocumentScope,
} from "./DocumentScope.ts";
import { downloadOnDocument } from "./DownloadOnDocument.ts";
import { rejectsSelector } from "./FindElements.ts";
import { forAtMost } from "./ForAtMost.ts";
import { probeDocument } from "./ProbeDocument.ts";
import { auditPage, readLinkTargets, readPage } from "./ReadPage.ts";
import { runPageScript } from "./RunPageScript.ts";
import { screenshotDocument, screenshotHidingFields } from "./ScreenshotDocument.ts";
import type { DocumentDetails } from "./SessionDetails.ts";
import { CRASHED, waitUntilFound } from "./WaitUntilActionable.ts";

// A navigation is given at least this long to load, however short the step's timeout.
const SHORTEST_NAVIGATION_MILLISECONDS = 10_000;

async function navigateDocument<Handle>(
    scope: DocumentScope<Handle>,
    url: string,
    options: NavigateOptions,
): Promise<Result<void, DriverError>> {
    const { events, timeout } = scope;
    if (events.crashed()) {
        return failure(CRASHED);
    }
    const alreadyRefused = failureOfRefusedDecision(scope, "navigation-failed");
    if (alreadyRefused !== null) {
        return failure(alreadyRefused);
    }
    // Scripts are a setting of the whole page, so only the top document's navigate turns them off.
    if (options.scripts === "disabled" && !isTopDocument(scope)) {
        return failure({
            code: "unsupported-step",
            detail: "scripts can be turned off only for the top document",
        });
    }
    try {
        await scope.operations.navigate(
            url,
            Math.max(timeout, SHORTEST_NAVIGATION_MILLISECONDS),
            options.scripts,
        );
        // What the page started as it loaded is the navigate's, once it has reached the browser, and
        // a navigation of its own as it loaded may yet turn out to be a download.
        await forAtMost(timeout, inputSettled(scope));
        const refused = failureOfRefusedDecision(scope, "navigation-failed");
        return refused === null ? success(undefined) : failure(refused);
    } catch (error) {
        return failure(
            events.crashed() ? CRASHED : { code: "navigation-failed", detail: errorText(error) },
        );
    }
}

async function frameOf<Handle>(
    scope: DocumentScope<Handle>,
    locator: ResolvedLocator,
): Promise<Result<DocumentSession, DriverError>> {
    const { operations, events } = scope;
    if (events.crashed()) {
        return failure(CRASHED);
    }
    let inner: CheckedDocument<Handle> | null;
    try {
        if (await rejectsSelector(operations, locator)) {
            return failure(SELECTOR_INVALID);
        }
        const found = await waitUntilFound(operations, locator, scope.timeout, () =>
            events.crashed(),
        );
        if (!found.ok) {
            return found;
        }
        inner = await scope.clickChecks.frame(found.value);
    } catch (error) {
        return failure(failureOfThrow(scope, error));
    }
    // An element that is no iframe, or an iframe whose document runs in another process.
    if (inner === null) {
        return failure({
            code: "unsupported-step",
            detail: "the element is not an iframe whose document this driver can reach",
        });
    }
    return success(
        documentPorts(
            inner.operations,
            inner.checks,
            [...scope.masked, inner.operations],
            scope.environment,
            scope.details,
        ),
    );
}

export function documentPorts<Handle>(
    operations: PageOperations<Handle>,
    clickChecks: HitChecks<Handle>,
    masked: readonly PageOperations<Handle>[],
    environment: SessionEnvironment,
    details: DocumentDetails,
): DocumentSession {
    const scope: DocumentScope<Handle> = {
        operations,
        clickChecks,
        masked,
        environment,
        details,
        events: details.events,
        timeout: environment.timeoutMilliseconds,
    };
    return {
        navigate: (url, options) => navigateDocument(scope, url, options),
        page: () => readPage(scope),
        act: (action, guard) => actOnDocument(scope, action, guard),
        probe: (locator, read) => probeDocument(scope, locator, read),
        download: (step, maximumBytes, guard) =>
            downloadOnDocument(scope, step, maximumBytes, guard),
        runScript: (call) => runPageScript(scope, call),
        screenshot: (mask) => screenshotDocument(scope, mask),
        screenshotHidingFields: (mask, fields, holdsSecret) =>
            screenshotHidingFields(scope, mask, fields, holdsSecret),
        audit: () => auditPage(scope),
        accessibilitySnapshot: () => readOfPage(scope, () => operations.accessibilityTree()),
        linkTargets: () => readLinkTargets(scope),
        frame: (locator) => frameOf(scope, locator),
        crashed: () => details.events.crashed(),
        unsupportedOpenings: () => details.events.unsupportedOpenings(),
    };
}
