import {
    DriverErrorCode,
    failure,
    success,
    type A11yNode,
    type ActionGuard,
    type ClipboardPort,
    type ClockPort,
    type DriverError,
    type NetworkPort,
    type PageProbe,
    type Result,
    type Session,
    type StoragePort,
} from "@revisum/engine";
import { fakeClipboardPort } from "./FakeClipboardPort.ts";
import { fakeClockPort } from "./FakeClockPort.ts";
import { fakeNetworkPort } from "./FakeNetworkPort.ts";
import {
    actOnOpenPage,
    downloadOnOpenPage,
    NO_DIALOG,
    NO_GUARD,
    performableAction,
    performableDownload,
    probeOpenPage,
    READ_FAILED,
    TAB_GONE,
    type FakePage,
} from "./FakePage.ts";
import { fakeStoragePort } from "./FakeStoragePort.ts";
import { leaveOut, type OptionalMember } from "./LeaveOut.ts";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

export { FAKE_DOWNLOAD, FAKE_ELEMENT } from "./FakePage.ts";

export const FAKE_PAGE: PageProbe = {
    url: "https://app.example/",
    title: "Fake page",
};
export const FAKE_SNAPSHOT: A11yNode = {
    role: "document",
    name: "",
    children: [],
};
export const FAKE_PNG = new Uint8Array([137, 80, 78, 71]);

// A session as a test holds it: the port, its calls, and a way to have the page open a dialog.
export type FakeSession = Recorded<Session> & {
    // Holds the page with a dialog saying `text`, until a dialog step answers it.
    openDialog(text: string): void;
    // The tabs it has opened by default, in order, each with its own calls.
    openedTabs(): readonly FakeSession[];
};

// The real driver loses its connection on close, and reports that as a crash on anything it is
// then asked to do.
const CLOSED: DriverError = {
    code: DriverErrorCode.TargetCrashed,
    detail: "the session has closed",
};
const unreachable = <Value>(what: string): Promise<Value> =>
    Promise.reject(new Error(`${what} cannot be read from a page that has gone`));
const refusing = <Value>(error: DriverError): Promise<Result<Value, DriverError>> =>
    Promise.resolve(failure(error));

const refusingOnceClosed = <Value>(guard: ActionGuard): Promise<Result<Value, DriverError>> =>
    refusing(typeof guard === "function" ? CLOSED : NO_GUARD);

// The port as given, until `hasEnded` says it has gone: from then on the `ended` port answers every
// member. It decides at each call, so a copy of the port made earlier ends with it.
function untilEnded<Port extends object>(open: Port, ended: Port, hasEnded: () => boolean): Port {
    return new Proxy(open, {
        get(target, member) {
            const value: unknown = Reflect.get(target, member);
            if (typeof value !== "function") {
                return value;
            }
            return (...given: unknown[]): unknown => {
                const answering: unknown = hasEnded() ? Reflect.get(ended, member) : value;
                return typeof answering === "function"
                    ? Reflect.apply(answering, target, given)
                    : answering;
            };
        },
    });
}

const storageRefusing = (error: DriverError): Required<StoragePort> => ({
    write: () => refusing(error),
    remove: () => refusing(error),
    read: () => refusing(error),
});
const STORAGE_ONCE_CLOSED = storageRefusing(CLOSED);
const STORAGE_ONCE_TAB_CLOSED = storageRefusing({
    code: DriverErrorCode.NotActionable,
    detail: "the tab has closed",
});
const CLOCK_ONCE_CLOSED: Required<ClockPort> = { advance: () => refusing(CLOSED) };
const CLIPBOARD_ONCE_CLOSED: Required<ClipboardPort> = { readText: () => refusing(CLOSED) };

// Nothing reaches the page once the session has closed: what can fail says the target crashed, a read
// that cannot say so throws, and a probe reads nothing. A missing guard is refused first, as ever.
// What the session noted while it ran can still be asked for, and the network port only reads back
// what it recorded, so it goes on answering.
function answersOnceClosed(open: Required<Session>): Required<Session> {
    return {
        browser: open.browser,
        navigate: () => refusing(CLOSED),
        page: () => unreachable("the page"),
        act: (...[, guard]) => refusingOnceClosed(guard),
        probe: () => Promise.resolve(READ_FAILED),
        screenshot: () => unreachable("a screenshot"),
        screenshotHidingFields: () => unreachable("a screenshot"),
        audit: () => unreachable("an audit"),
        accessibilitySnapshot: () => unreachable("the accessibility tree"),
        frame: () => refusing(CLOSED),
        crashed: () => true,
        isDialogOpen: () => false,
        unsupportedOpenings: () => open.unsupportedOpenings(),
        download: (...[, , guard]) => refusingOnceClosed(guard),
        runScript: () => refusing(CLOSED),
        linkTargets: () => unreachable("the links"),
        blockedOrigins: () => open.blockedOrigins(),
        connectionFailures: () => open.connectionFailures(),
        refusedRequestDecisions: () => open.refusedRequestDecisions(),
        close: () => Promise.resolve(),
        newTab: () => refusing(CLOSED),
        network: open.network,
        storage: open.storage,
        clock: open.clock,
        clipboard: open.clipboard,
    };
}

// A tab closed in a session that goes on: its target has gone but the connection has not, so no crash
// is reported. A wait finds nothing and every other command fails as it does on a target that has
// gone. What a driver refuses before it touches the page comes first, as on an open tab.
function answersOnceTabClosed(open: Required<Session>): Required<Session> {
    return {
        ...answersOnceClosed(open),
        navigate: () =>
            refusing({ code: DriverErrorCode.NavigationFailed, detail: "the tab has closed" }),
        act(step, guard, secret) {
            if (typeof guard !== "function") {
                return refusing(NO_GUARD);
            }
            if (step.type === "dialog") {
                return refusing(NO_DIALOG);
            }
            const action = performableAction(step, secret);
            return Promise.resolve(action.ok ? failure(TAB_GONE) : action);
        },
        frame: () => refusing(TAB_GONE),
        crashed: () => false,
        download(...[step, , guard]) {
            if (typeof guard !== "function") {
                return refusing(NO_GUARD);
            }
            const locator = performableDownload(step);
            return Promise.resolve(locator.ok ? failure(TAB_GONE) : locator);
        },
        runScript: () =>
            refusing({ code: DriverErrorCode.ScriptFailed, detail: "the tab has closed" }),
    };
}

// What a document's page does unless a test says otherwise. Its frames are the document itself.
function pageAnswers(
    page: FakePage,
    thisDocument: () => Session,
): Omit<Required<Session>, "close" | "newTab" | "network" | "storage" | "clock" | "clipboard"> {
    return {
        browser: { name: "fake-browser", version: "1.0" },
        navigate: () => Promise.resolve(success(undefined)),
        page: () => Promise.resolve(FAKE_PAGE),
        act: (step, guard, secret) => Promise.resolve(actOnOpenPage(page, step, guard, secret)),
        probe: (locator) => Promise.resolve(probeOpenPage(page, locator)),
        screenshot: () => Promise.resolve(FAKE_PNG),
        screenshotHidingFields: () => Promise.resolve(success(FAKE_PNG)),
        audit: () => Promise.resolve([]),
        accessibilitySnapshot: () => Promise.resolve(FAKE_SNAPSHOT),
        frame: () => Promise.resolve(success(thisDocument())),
        crashed: () => false,
        isDialogOpen: () => page.dialogText !== null,
        unsupportedOpenings: () => 0,
        download: (step, maximumBytes, guard) =>
            Promise.resolve(downloadOnOpenPage(page, step, maximumBytes, guard)),
        runScript: () => Promise.resolve(success("null")),
        linkTargets: () => Promise.resolve([]),
        blockedOrigins: () => [],
        connectionFailures: () => [],
        refusedRequestDecisions: () => [],
    };
}

const withTestControls = (
    port: Session,
    page: FakePage,
    tabs: readonly FakeSession[] = [],
): FakeSession =>
    recordCalls({
        ...port,
        openDialog: (text: string) => {
            page.dialogText = text;
        },
        openedTabs: () => [...tabs],
    });

// What a tab has of the session that opened it.
type SessionOfTab = {
    readonly overrides: Partial<Session>;
    readonly without: readonly OptionalMember<Session>[];
    readonly network: NetworkPort;
    readonly storage: StoragePort;
    readonly clock: ClockPort;
    readonly clipboard: ClipboardPort;
    readonly hasClosed: () => boolean;
};

// A fake of its own, which answers as its session was told to and shares the session's network, clock
// and clipboard. Web storage is its own page's, on the session's entries. It opens no tab of its own,
// and it ends with its own close or with the session's. A tab closed first has stopped watching its
// page by the time the session closes, so it goes on answering as a closed tab.
function fakeTab(session: SessionOfTab): FakeSession {
    let isClosed = false;
    const hasClosed = (): boolean => isClosed;
    const page: FakePage = { dialogText: null };
    const answers: Required<Session> = {
        ...pageAnswers(page, () => tab),
        ...session.overrides,
        close: () => {
            isClosed = true;
            return Promise.resolve();
        },
        newTab: () => refusing(CLOSED),
        network: session.network,
        storage: untilEnded(
            untilEnded(session.storage, STORAGE_ONCE_CLOSED, session.hasClosed),
            STORAGE_ONCE_TAB_CLOSED,
            hasClosed,
        ),
        clock: session.clock,
        clipboard: session.clipboard,
    };
    const tab = withTestControls(
        untilEnded(
            leaveOut<Session>(untilEnded(answers, answersOnceClosed(answers), session.hasClosed), [
                ...session.without,
                "newTab",
            ]),
            answersOnceTabClosed(answers),
            hasClosed,
        ),
        page,
    );
    return tab;
}

// A session on a page that accepts every action the guard allows and shows one element for every
// locator, with no dialog open until a test opens one. Its frames are the document they stand in, each
// tab is a fake of its own, and its close ends them all. It performs every optional feature, unless
// `without` names the ones it lacks.
export function fakeSession(
    overrides: Partial<Session> = {},
    without: readonly OptionalMember<Session>[] = [],
): FakeSession {
    let isClosed = false;
    const hasClosed = (): boolean => isClosed;
    const page: FakePage = { dialogText: null };
    const tabs: FakeSession[] = [];
    const answers: Required<Session> = {
        ...pageAnswers(page, () => session),
        close: () => Promise.resolve(),
        newTab: () => {
            const tab = fakeTab({
                overrides,
                without,
                network: answers.network,
                storage: answers.storage,
                clock: reachable.clock,
                clipboard: reachable.clipboard,
                hasClosed,
            });
            tabs.push(tab);
            return Promise.resolve(success(tab));
        },
        network: fakeNetworkPort(),
        storage: fakeStoragePort(),
        clock: fakeClockPort(),
        clipboard: fakeClipboardPort(),
        ...overrides,
    };
    const reachable: Required<Session> = {
        ...answers,
        storage: untilEnded(answers.storage, STORAGE_ONCE_CLOSED, hasClosed),
        clock: untilEnded(answers.clock, CLOCK_ONCE_CLOSED, hasClosed),
        clipboard: untilEnded(answers.clipboard, CLIPBOARD_ONCE_CLOSED, hasClosed),
        // A close that fails closed nothing, so the session goes on.
        close: async () => {
            await answers.close();
            isClosed = true;
        },
    };
    const session = withTestControls(
        untilEnded(leaveOut<Session>(reachable, without), answersOnceClosed(reachable), hasClosed),
        page,
        tabs,
    );
    return session;
}
