// The ports of one document: the top document of a tab, or an iframe's document inside it.
import {
    DriverErrorCode, NavigateScripts, failure,
    success,
    type DocumentSession,
    type DriverError,
    type NavigateOptions,
    type ResolvedLocator,
    type Result,
    type SessionEnvironment,
} from "@revisum/contracts";
import { errorText } from "../../connection/ErrorText.ts";
import { pageAnswers } from "../../in-page/document/AfterTwoFrames.ts";
import type { CheckedDocument, HitChecks } from "../../page/checks/HitChecks.ts";
import { PageHeldByDialog } from "../../page/failures/PageHeldByDialog.ts";
import type { PageOperations } from "../../page/PageOperations.ts";
import { actOnDocument } from "../actions/ActOnDocument.ts";
import {
    DIALOG_OPEN,
    failureOfRefusedDecision,
    failureOfThrow,
    inputSettled,
    isTopDocument,
    readWithinStep,
    SELECTOR_INVALID,
    waitWithin,
    withinStep,
    type DocumentScope,
} from "./DocumentScope.ts";
import { downloadOnDocument } from "../actions/DownloadOnDocument.ts";
import { rejectsSelector } from "./FindElements.ts";
import { forAtMost, notAnswering, SHORTEST_INPUT_MILLISECONDS, TIMED_OUT } from "../ForAtMost.ts";
import { probeDocument } from "./ProbeDocument.ts";
import { auditPage, readLinkTargets, readPage } from "./ReadPage.ts";
import { runPageScript } from "./RunPageScript.ts";
import { screenshotDocument, screenshotHidingFields } from "./ScreenshotDocument.ts";
import type { DocumentDetails } from "../SessionDetails.ts";
import { CRASHED, waitUntilFound } from "../actions/WaitUntilActionable.ts";

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
    if (options.scripts === NavigateScripts.Disabled && !isTopDocument(scope)) {
        return failure({
            code: DriverErrorCode.UnsupportedStep,
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
        const settled = await forAtMost(timeout, inputSettled(scope));
        const refused = failureOfRefusedDecision(scope, "navigation-failed");
        if (refused !== null) {
            return failure(refused);
        }
        return settled === TIMED_OUT && !(await isHeldByItsOwnScript(scope))
            ? failure(notAnswering(timeout))
            : success(undefined);
    } catch (error) {
        return failure(failureOfNavigation(scope, error));
    }
}

// Whether a settle that ran out of time was only the page's own script holding its thread, on a page
// the navigate reached, which is for the next step to find unreadable. A navigation of the page's own
// still on its way is not that, however little the page answers meanwhile: that is the navigate's
// effect not having arrived. Nor is a page that still answers and just never settled.
async function isHeldByItsOwnScript<Handle>(scope: DocumentScope<Handle>): Promise<boolean> {
    if ((await forAtMost(0, scope.events.navigationEnded())) === TIMED_OUT) {
        return false;
    }
    const answered = await forAtMost(
        Math.min(SHORTEST_INPUT_MILLISECONDS, scope.timeout),
        scope.operations.callForString(pageAnswers, []),
    );
    return answered === TIMED_OUT;
}

// A dead page says so before a dialog does. A dialog that opened as the document loaded is the
// page's to answer for, and a plan can reach a dialog step to answer it.
function failureOfNavigation<Handle>(scope: DocumentScope<Handle>, error: unknown): DriverError {
    if (scope.events.crashed()) {
        return CRASHED;
    }
    return error instanceof PageHeldByDialog
        ? DIALOG_OPEN
        : { code: DriverErrorCode.NavigationFailed, detail: errorText(error) };
}

async function frameOf<Handle>(
    scope: DocumentScope<Handle>,
    locator: ResolvedLocator,
): Promise<Result<DocumentSession, DriverError>> {
    const { operations, events } = scope;
    if (events.crashed()) {
        return failure(CRASHED);
    }
    const stepDeadline = Date.now() + scope.timeout;
    let inner: CheckedDocument<Handle> | null;
    try {
        if (await withinStep(scope, stepDeadline, () => rejectsSelector(operations, locator))) {
            return failure(SELECTOR_INVALID);
        }
        const found = await waitUntilFound(
            operations,
            locator,
            waitWithin(scope, stepDeadline),
            () => events.crashed(),
        );
        if (!found.ok) {
            return found;
        }
        inner = await withinStep(scope, stepDeadline, () => scope.clickChecks.frame(found.value));
    } catch (error) {
        return failure(failureOfThrow(scope, error));
    }
    // An element that is no iframe, or an iframe whose document runs in another process.
    if (inner === null) {
        return failure({
            code: DriverErrorCode.UnsupportedStep,
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
            scope.topDocument,
        ),
    );
}

export function documentPorts<Handle>(
    operations: PageOperations<Handle>,
    clickChecks: HitChecks<Handle>,
    masked: readonly PageOperations<Handle>[],
    environment: SessionEnvironment,
    details: DocumentDetails,
    topDocument: CheckedDocument<Handle> = { operations, checks: clickChecks },
): DocumentSession {
    const scope: DocumentScope<Handle> = {
        operations,
        clickChecks,
        masked,
        topDocument,
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
        accessibilitySnapshot: () => readWithinStep(scope, () => operations.accessibilityTree()),
        linkTargets: () => readLinkTargets(scope),
        frame: (locator) => frameOf(scope, locator),
        crashed: () => details.events.crashed(),
        unsupportedOpenings: () => details.events.unsupportedOpenings(),
    };
}
