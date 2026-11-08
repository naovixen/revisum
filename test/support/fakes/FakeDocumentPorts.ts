// A document on a protocol that needs no browser: the real document ports over a page whose answers a
// test decides, through the seam each browser protocol implements. Nothing of the driver's own is
// replaced, so a test sees exactly what the ports do with what the page gives.
import { success, type DocumentSession, type DriverError, type Result } from "@revisum/engine";
import type { PageEvents } from "../../../packages/driver-cdp/src/page/PageEvents.ts";
import type { DownloadCapture } from "../../../packages/driver-cdp/src/capabilities/DownloadCapture.ts";
import type { HitChecks } from "../../../packages/driver-cdp/src/page/HitChecks.ts";
import { HitCheckOutcome } from "../../../packages/driver-cdp/src/page/HitChecks.ts";
import {
    SelectOutcome,
    type PageOperations,
} from "../../../packages/driver-cdp/src/page/PageOperations.ts";
import { documentPorts } from "../../../packages/driver-cdp/src/session/DocumentPorts.ts";
import { baseUrlOf } from "../policy-clearance.ts";

// How many milliseconds a step has, unless a test says otherwise.
const DEFAULT_STEP_TIMEOUT_MILLISECONDS = 2000;
const FAKE_ORIGIN = "http://127.0.0.1:1";
const FAKE_FIXTURE_PATH = "E:/fixtures/note.txt";

export type FakeDocumentOptions = {
    readonly timeoutMilliseconds?: number;
    readonly operations?: Partial<PageOperations<string>>;
    readonly events?: Partial<PageEvents>;
    readonly hitChecks?: Partial<HitChecks<string>>;
    readonly downloads?: DownloadCapture;
    readonly fixturePath?: (fixture: string) => Result<string, DriverError>;
};

const NO_PAGE_ANSWER = "the fake page gives no such answer";

function fakeOperations(overrides: Partial<PageOperations<string>>): PageOperations<string> {
    return {
        navigate: () => Promise.resolve(),
        callForString: () => Promise.resolve("valid"),
        twoFramesLater: () => Promise.resolve(),
        callForElements: () => Promise.resolve([]),
        byRole: () => Promise.resolve([]),
        accessibilityTree: () => Promise.reject(new Error(NO_PAGE_ANSWER)),
        roleAndName: () => Promise.resolve({ role: null, name: null }),
        exposedStates: () => Promise.resolve({ selected: null, expanded: null, pressed: null }),
        isElementGone: () => Promise.resolve(false),
        frameId: () => Promise.resolve("main-frame"),
        canPressStartAnything: () => Promise.resolve(true),
        isCustomElementEnabled: () => Promise.resolve(true),
        screenshotPng: () => Promise.reject(new Error(NO_PAGE_ANSWER)),
        unreachableUrl: () => Promise.resolve(null),
        callForStringInMainWorld: () => Promise.resolve("{}"),
        ...overrides,
    };
}

const fakeEvents = (overrides: Partial<PageEvents>): PageEvents => ({
    crashed: () => false,
    openDialog: () => null,
    answerDialog: () => Promise.resolve(),
    navigationEnded: () => Promise.resolve(),
    refusedRequestDecisions: () => [],
    unsupportedOpenings: () => 0,
    ...overrides,
});

const HIT_CHECKS_ON_THE_FAKE_PAGE: HitChecks<string> = {
    around: () => Promise.resolve(HitCheckOutcome.Hit),
    input: {
        hover: () => Promise.resolve(),
        fill: () => Promise.resolve(),
        press: () => Promise.resolve(),
        setFiles: () => Promise.resolve(),
        select: () => Promise.resolve(SelectOutcome.Selected),
        callScript: () => Promise.resolve({ kind: "result", text: "null" }),
    },
    frame: () => Promise.resolve(null),
};

export function fakeDocumentPorts(options: FakeDocumentOptions = {}): DocumentSession {
    const operations = fakeOperations(options.operations ?? {});
    const events = fakeEvents(options.events ?? {});
    const timeoutMilliseconds = options.timeoutMilliseconds ?? DEFAULT_STEP_TIMEOUT_MILLISECONDS;
    return documentPorts(
        operations,
        { ...HIT_CHECKS_ON_THE_FAKE_PAGE, ...options.hitChecks },
        [operations],
        {
            baseUrl: baseUrlOf(FAKE_ORIGIN),
            allowedOrigins: [],
            seed: 1,
            fixedTimeMilliseconds: 0,
            sensitiveSelectors: [],
            timeoutMilliseconds,
        },
        {
            events,
            fixturePath: options.fixturePath ?? (() => success(FAKE_FIXTURE_PATH)),
            downloads: options.downloads ?? {
                arm: () => {
                    throw new Error("the fake page starts no download");
                },
            },
            secretTypedFields: [],
        },
    );
}
