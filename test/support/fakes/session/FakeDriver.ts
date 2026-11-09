import { failure, success, type BrowserDriver, type Session } from "@revisum/engine";
import { fakeSession } from "./FakeSession.ts";
import { leaveOut, type OptionalMember } from "../LeaveOut.ts";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

export type FakeDriver = Recorded<BrowserDriver>;

// A driver for every target that opens a fresh fake session each time, unless a test overrides it.
export function fakeDriver(
    overrides: Partial<BrowserDriver> = {},
    without: readonly OptionalMember<BrowserDriver>[] = [],
): FakeDriver {
    const defaults: Required<BrowserDriver> = {
        info: {
            id: "cdp",
            version: "fake",
            protocol: "none",
        },
        supports: () => success(true),
        open: () => Promise.resolve(success(fakeSession())),
        build: () =>
            Promise.resolve(success({ version: "1.0", executablePath: import.meta.filename })),
    };
    return recordCalls(leaveOut<BrowserDriver>({ ...defaults, ...overrides }, without));
}

// A fake driver whose every open gives this one session.
export const fakeDriverOpening = (
    session: Session,
    overrides: Partial<BrowserDriver> = {},
): FakeDriver => fakeDriver({ open: () => Promise.resolve(success(session)), ...overrides });

// A fake driver that gets as far as being asked, but never launches a browser, so a test can tell
// whether a plan reached it at all.
export const fakeDriverNeverLaunching = (
    overrides: Partial<BrowserDriver> = {},
    without: readonly OptionalMember<BrowserDriver>[] = [],
): FakeDriver =>
    fakeDriver(
        {
            open: () =>
                Promise.resolve(
                    failure({
                        reason: "launch-failed",
                        detail: "the fake never launches",
                    }),
                ),
            ...overrides,
        },
        without,
    );
