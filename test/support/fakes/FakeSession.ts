import {
    sha256,
    success,
    type A11yNode,
    type ElementProbe,
    type PageProbe,
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

export type FakeSession = Recorded<Session>;

// A session on a page that accepts every action and shows one element for every locator. Its
// frames and tabs are the session itself, and it performs every optional feature, unless `without`
// names the ones it lacks.
export function fakeSession(
    overrides: Partial<Session> = {},
    without: readonly OptionalMember<Session>[] = [],
): FakeSession {
    const defaults: Required<Session> = {
        browser: { name: "fake-browser", version: "1.0" },
        navigate: () => Promise.resolve(success(undefined)),
        page: () => Promise.resolve(FAKE_PAGE),
        act: () => Promise.resolve(success(undefined)),
        probe: () => Promise.resolve(FAKE_ELEMENT),
        screenshot: () => Promise.resolve(FAKE_PNG),
        screenshotHidingFields: () => Promise.resolve(success(FAKE_PNG)),
        audit: () => Promise.resolve([]),
        accessibilitySnapshot: () => Promise.resolve(FAKE_SNAPSHOT),
        frame: () => Promise.resolve(success(session)),
        crashed: () => false,
        isDialogOpen: () => false,
        unsupportedOpenings: () => 0,
        download: () => {
            const bytes = new TextEncoder().encode("downloaded");
            return Promise.resolve(
                success({
                    fileName: "download.txt",
                    mediaType: "text/plain",
                    bytes,
                    sha256: sha256(bytes),
                }),
            );
        },
        runScript: () => Promise.resolve(success("null")),
        linkTargets: () => Promise.resolve([]),
        blockedOrigins: () => [],
        connectionFailures: () => [],
        refusedRequestDecisions: () => [],
        close: () => Promise.resolve(),
        newTab: () => Promise.resolve(success(session)),
        network: fakeNetworkPort(),
        storage: fakeStoragePort(),
        clock: fakeClockPort(),
        clipboard: fakeClipboardPort(),
    };
    const session: FakeSession = recordCalls(
        leaveOut<Session>({ ...defaults, ...overrides }, without),
    );
    return session;
}
