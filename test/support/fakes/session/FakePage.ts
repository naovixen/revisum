// One document's page in a fake session: what it does with an action on a page still open, by the
// same rules the real driver applies.
import {
    DriverErrorCode,
    failure,
    SemanticLocatorKind,
    sha256,
    StructuralLocatorKind,
    success,
    UnreadablePage,
    type ActionGuard,
    type DownloadedFile,
    type DriverError,
    type ElementProbe,
    type OneElementRead,
    type PageReadFailure,
    type PerformableAction,
    type ResolvedDialogStep,
    type ResolvedDownloadStep,
    type ResolvedElement,
    type ResolvedLocator,
    type Result,
} from "@revisum/engine";
import { StepType, PolicyVerdictKind } from "@revisum/contracts";

export const FAKE_ELEMENT: OneElementRead = {
    count: 1,
    visible: true,
    enabled: true,
    text: "Ready",
    value: null,
    sensitive: false,
    box: null,
    states: { selected: null, expanded: null, pressed: null, current: null },
    href: null,
};
export const FAKE_DOWNLOAD = new TextEncoder().encode("downloaded");

const NO_ELEMENT: ResolvedElement = {
    role: null,
    name: null,
    box: null,
    formSubmitName: null,
    linkUrl: null,
};

// The element a locator finds on the fake page, as the guard is told of it. Only a locator that
// names its element gives it a name: a test id or a selector says nothing of what the control does,
// which is why a guard may refuse to let a click on one through.
function elementFoundBy(locator: ResolvedLocator): ResolvedElement {
    switch (locator.by) {
        case SemanticLocatorKind.Role:
            return { ...NO_ELEMENT, role: locator.role, name: locator.name };
        case SemanticLocatorKind.Label:
            return { ...NO_ELEMENT, role: "textbox", name: locator.label };
        case SemanticLocatorKind.Text:
            return { ...NO_ELEMENT, name: locator.text };
        case SemanticLocatorKind.TestId:
            return { ...NO_ELEMENT, testId: locator.testId };
        case StructuralLocatorKind.Css:
        case StructuralLocatorKind.Xpath:
            return NO_ELEMENT;
    }
}

export const TAB_GONE: DriverError = {
    code: DriverErrorCode.NotFound,
    detail: "the tab has closed, so nothing on it can be found",
};
export const NO_DIALOG: DriverError = {
    code: DriverErrorCode.NotFound,
    detail: "no dialog is open",
};
export const DIALOG_HOLDS_PAGE: PageReadFailure = {
    code: DriverErrorCode.DialogOpen,
    detail: "a dialog is open: a dialog step must answer it first",
};

export const READ_FAILED: ElementProbe = { count: UnreadablePage.ReadFailed };
const DIALOG_HOLDS_PROBE: ElementProbe = { count: UnreadablePage.DialogOpen };

function guardDenial(
    element: ResolvedElement,
    dialogText: string | null,
    guard: ActionGuard,
): DriverError | null {
    const verdict = guard(element, dialogText);
    return verdict.kind === PolicyVerdictKind.Deny
        ? { code: DriverErrorCode.PolicyDenied, detail: `denied by the ${verdict.rule} rule` }
        : null;
}

// What one document's page has open.
export type FakePage = { dialogText: string | null };

const withWhitespaceCollapsed = (text: string): string => text.replace(/\s+/g, " ").trim();

// Answers the page's dialog: its text is checked first, then shown to the guard.
function answerDialog(
    page: FakePage,
    step: ResolvedDialogStep,
    guard: ActionGuard,
): Result<void, DriverError> {
    const text = page.dialogText;
    if (text === null) {
        return failure(NO_DIALOG);
    }
    if (step.expectText !== undefined) {
        if (withWhitespaceCollapsed(step.expectText) !== withWhitespaceCollapsed(text)) {
            return failure({
                code: DriverErrorCode.AssertionFailed,
                detail: "the open dialog does not say the expected text",
            });
        }
    }
    const denied = guardDenial(NO_ELEMENT, text, guard);
    if (denied !== null) {
        return failure(denied);
    }
    page.dialogText = null;
    return success(undefined);
}

export function actOnOpenPage(
    page: FakePage,
    action: PerformableAction,
    guard: ActionGuard,
): Result<void, DriverError> {
    if (action.type === StepType.Dialog) {
        return answerDialog(page, action, guard);
    }
    if (page.dialogText !== null) {
        return failure(DIALOG_HOLDS_PAGE);
    }
    const denied = guardDenial(elementFoundBy(action.locator), null, guard);
    return denied === null ? success(undefined) : failure(denied);
}

export function downloadOnOpenPage(
    page: FakePage,
    step: ResolvedDownloadStep,
    maximumBytes: number,
    guard: ActionGuard,
): Result<DownloadedFile, DriverError> {
    if (page.dialogText !== null) {
        return failure(DIALOG_HOLDS_PAGE);
    }
    const denied = guardDenial(elementFoundBy(step.locator), null, guard);
    if (denied !== null) {
        return failure(denied);
    }
    if (FAKE_DOWNLOAD.length > maximumBytes) {
        return failure({
            code: DriverErrorCode.DownloadTooLarge,
            detail: `the file is larger than ${maximumBytes} bytes`,
        });
    }
    return success({
        fileName: "download.txt",
        mediaType: "text/plain",
        bytes: FAKE_DOWNLOAD,
        sha256: sha256(FAKE_DOWNLOAD),
    });
}

export function probeOpenPage(page: FakePage): ElementProbe {
    return page.dialogText === null ? FAKE_ELEMENT : DIALOG_HOLDS_PROBE;
}
