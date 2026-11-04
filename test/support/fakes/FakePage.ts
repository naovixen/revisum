// One document's page in a fake session: what it does with an action on a page still open, and what
// a driver refuses before it touches the page, by the same rules the real driver applies.
import {
    DriverErrorCode,
    failure,
    literalActionStep,
    literalText,
    performableLocator,
    SemanticLocatorKind,
    sha256,
    StructuralLocatorKind,
    success,
    UnreadablePage,
    type ActionGuard,
    type ActionStep,
    type DialogStep,
    type DownloadedFile,
    type DownloadStep,
    type DriverError,
    type ElementProbe,
    type ElementsRead,
    type Locator,
    type ResolvedActionStep,
    type ResolvedElement,
    type ResolvedLocator,
    type Result,
    type Secret,
} from "@revisum/engine";

export const FAKE_ELEMENT: ElementsRead = {
    count: 1,
    visible: true,
    enabled: true,
    text: "Ready",
    value: null,
    sensitive: false,
    box: null,
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
const DIALOG_HOLDS_PAGE: DriverError = {
    code: DriverErrorCode.DialogOpen,
    detail: "a dialog is open: a dialog step must answer it first",
};

export const READ_FAILED: ElementProbe = { count: UnreadablePage.ReadFailed };
const DIALOG_HOLDS_PROBE: ElementProbe = { count: UnreadablePage.DialogOpen };

const isSecretMissing = (action: ResolvedActionStep, secret: Secret | undefined): boolean =>
    action.type === "fill" &&
    typeof action.value === "object" &&
    "secretName" in action.value &&
    secret?.name !== action.value.secretName;

// The step as a driver performs it, or why it refuses before it touches the page. A value reference
// left in the step means the engine did not replace it, and a secret reference without its secret
// leaves nothing to type, and typing nothing could pass a step that should fail.
export function performableAction(
    step: Exclude<ActionStep, DialogStep>,
    secret: Secret | undefined,
): Result<ResolvedActionStep, DriverError> {
    const action = literalActionStep(step);
    if (action === undefined) {
        return failure({
            code: DriverErrorCode.UnsupportedStep,
            detail: `this driver does not perform this ${step.type} step`,
        });
    }
    if (isSecretMissing(action, secret)) {
        return failure({
            code: DriverErrorCode.NotActionable,
            detail: "a secret reference reached the driver without its secret",
        });
    }
    return success(action);
}

export function performableDownload(step: DownloadStep): Result<ResolvedLocator, DriverError> {
    const locator = performableLocator(step.locator);
    return locator === undefined
        ? failure({
              code: DriverErrorCode.UnsupportedStep,
              detail: "this driver does not perform this download step",
          })
        : success(locator);
}

function guardDenial(
    element: ResolvedElement,
    dialogText: string | null,
    guard: ActionGuard,
): DriverError | null {
    const verdict = guard(element, dialogText);
    return verdict.kind === "deny"
        ? { code: DriverErrorCode.PolicyDenied, detail: `denied by the ${verdict.rule} rule` }
        : null;
}

// What one document's page has open.
export type FakePage = { dialogText: string | null };

const withWhitespaceCollapsed = (text: string): string => text.replace(/\s+/g, " ").trim();

// Answers the page's dialog: its text is checked first, then shown to the guard.
function answerDialog(
    page: FakePage,
    step: DialogStep,
    guard: ActionGuard,
): Result<void, DriverError> {
    const text = page.dialogText;
    if (text === null) {
        return failure(NO_DIALOG);
    }
    if (step.expectText !== undefined) {
        const expected = literalText(step.expectText);
        if (expected === undefined) {
            return failure({
                code: DriverErrorCode.UnsupportedStep,
                detail: "a value reference reached the driver",
            });
        }
        if (withWhitespaceCollapsed(expected) !== withWhitespaceCollapsed(text)) {
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
    step: ActionStep,
    guard: ActionGuard,
    secret: Secret | undefined,
): Result<void, DriverError> {
    if (step.type === "dialog") {
        return answerDialog(page, step, guard);
    }
    const action = performableAction(step, secret);
    if (!action.ok) {
        return action;
    }
    if (page.dialogText !== null) {
        return failure(DIALOG_HOLDS_PAGE);
    }
    const denied = guardDenial(elementFoundBy(action.value.locator), null, guard);
    return denied === null ? success(undefined) : failure(denied);
}

export function downloadOnOpenPage(
    page: FakePage,
    step: DownloadStep,
    maximumBytes: number,
    guard: ActionGuard,
): Result<DownloadedFile, DriverError> {
    const locator = performableDownload(step);
    if (!locator.ok) {
        return locator;
    }
    if (page.dialogText !== null) {
        return failure(DIALOG_HOLDS_PAGE);
    }
    const denied = guardDenial(elementFoundBy(locator.value), null, guard);
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

export function probeOpenPage(page: FakePage, locator: Locator): ElementProbe {
    if (performableLocator(locator) === undefined) {
        return READ_FAILED;
    }
    return page.dialogText === null ? FAKE_ELEMENT : DIALOG_HOLDS_PROBE;
}
