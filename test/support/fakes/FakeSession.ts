import {
    DriverErrorCode,
    failure,
    literalText,
    SemanticLocatorKind,
    sha256,
    success,
    type A11yNode,
    type ActionGuard,
    type ActionStep,
    type DownloadedFile,
    type DownloadStep,
    type DriverError,
    type ElementProbe,
    type Locator,
    type PageProbe,
    type ResolvedElement,
    type Result,
    type Session,
} from "@revisum/engine";
import { fakeClipboardPort } from "./FakeClipboardPort.ts";
import { fakeClockPort } from "./FakeClockPort.ts";
import { fakeNetworkPort } from "./FakeNetworkPort.ts";
import { fakeStoragePort } from "./FakeStoragePort.ts";
import { leaveOut, type OptionalMember } from "./LeaveOut.ts";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

export const FAKE_PAGE: PageProbe = {
    url: "https://app.example/",
    title: "Fake page",
};
export const FAKE_ELEMENT: ElementProbe = {
    count: 1,
    visible: true,
    enabled: true,
    text: "Ready",
    value: null,
    sensitive: false,
    box: null,
};
export const FAKE_SNAPSHOT: A11yNode = {
    role: "document",
    name: "",
    children: [],
};
export const FAKE_PNG = new Uint8Array([137, 80, 78, 71]);
export const FAKE_DOWNLOAD = new TextEncoder().encode("downloaded");

export type FakeSession = Recorded<Session>;

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
function elementFoundBy(locator: Locator): ResolvedElement {
    switch (locator.by) {
        case SemanticLocatorKind.Role:
            return {
                ...NO_ELEMENT,
                role: locator.role,
                name: literalText(locator.name) ?? null,
            };
        case SemanticLocatorKind.Label:
            return { ...NO_ELEMENT, role: "textbox", name: literalText(locator.label) ?? null };
        case SemanticLocatorKind.Text:
            return { ...NO_ELEMENT, name: literalText(locator.text) ?? null };
        case SemanticLocatorKind.TestId: {
            const testId = literalText(locator.testId);
            return testId === undefined ? NO_ELEMENT : { ...NO_ELEMENT, testId };
        }
        default:
            return NO_ELEMENT;
    }
}

const NO_GUARD: DriverError = {
    code: DriverErrorCode.PolicyDenied,
    detail: "no runtime guard was given, so nothing can allow the action",
};
// The real driver loses its connection on close, and reports that as a crash on anything it is
// then asked to do.
const CLOSED: DriverError = {
    code: DriverErrorCode.TargetCrashed,
    detail: "the session has closed",
};

// Why the guard stops this step, or null when it lets the step's input event go. A dialog step acts
// on no element, and the fake page has no dialog text to show it.
function guardDenial(step: ActionStep, guard: ActionGuard): DriverError | null {
    if (typeof guard !== "function") {
        return NO_GUARD;
    }
    const found = "locator" in step ? elementFoundBy(step.locator) : NO_ELEMENT;
    const verdict = guard(found, null);
    return verdict.kind === "deny"
        ? { code: DriverErrorCode.PolicyDenied, detail: `denied by the ${verdict.rule} rule` }
        : null;
}

function actOnOpenSession(step: ActionStep, guard: ActionGuard): Result<void, DriverError> {
    const denied = guardDenial(step, guard);
    return denied === null ? success(undefined) : failure(denied);
}

function downloadOnOpenSession(
    step: DownloadStep,
    maximumBytes: number,
    guard: ActionGuard,
): Result<DownloadedFile, DriverError> {
    const denied = guardDenial(step, guard);
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

// A session on a page that accepts every action the guard allows and shows one element for every
// locator. Its frames and tabs are the session itself, and it performs every optional feature,
// unless `without` names the ones it lacks.
export function fakeSession(
    overrides: Partial<Session> = {},
    without: readonly OptionalMember<Session>[] = [],
): FakeSession {
    let isClosed = false;
    let openTabs = 0;
    const defaults: Required<Session> = {
        browser: { name: "fake-browser", version: "1.0" },
        navigate: () => Promise.resolve(success(undefined)),
        page: () => Promise.resolve(FAKE_PAGE),
        act: (step, guard) =>
            Promise.resolve(isClosed ? failure(CLOSED) : actOnOpenSession(step, guard)),
        probe: () => Promise.resolve(FAKE_ELEMENT),
        screenshot: () => Promise.resolve(FAKE_PNG),
        screenshotHidingFields: () => Promise.resolve(success(FAKE_PNG)),
        audit: () => Promise.resolve([]),
        accessibilitySnapshot: () => Promise.resolve(FAKE_SNAPSHOT),
        frame: () => Promise.resolve(success(session)),
        crashed: () => isClosed,
        isDialogOpen: () => false,
        unsupportedOpenings: () => 0,
        download: (step, maximumBytes, guard) =>
            Promise.resolve(
                isClosed ? failure(CLOSED) : downloadOnOpenSession(step, maximumBytes, guard),
            ),
        runScript: () => Promise.resolve(success("null")),
        linkTargets: () => Promise.resolve([]),
        blockedOrigins: () => [],
        connectionFailures: () => [],
        refusedRequestDecisions: () => [],
        close: () => Promise.resolve(),
        newTab: () => {
            openTabs++;
            return Promise.resolve(success(session));
        },
        network: fakeNetworkPort(),
        storage: fakeStoragePort(),
        clock: fakeClockPort(),
        clipboard: fakeClipboardPort(),
    };
    const answers = { ...defaults, ...overrides };
    // A tab is this same session, so the close after a newTab ends the tab and the session goes on.
    const close = async (): Promise<void> => {
        await answers.close();
        if (openTabs > 0) {
            openTabs--;
        } else {
            isClosed = true;
        }
    };
    const session: FakeSession = recordCalls(leaveOut<Session>({ ...answers, close }, without));
    return session;
}
