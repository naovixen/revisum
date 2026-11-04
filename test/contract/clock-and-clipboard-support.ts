// Shared setup for the browser tests of the plan language's clock advances and clipboard checks:
// the driver parts of each, carried out by the own CDP driver's clock and clipboard ports.
//
// It serves the clock-and-clipboard fixture app (fixtures/clock-and-clipboard-app/). Beside the
// app's files it answers two routes: /api/late-code, which answers in two parts 150 ms apart, so
// a copy that waits for it lands about 300 ms after its click; and /leaks.html, the leak page with
// a canary name made fresh for the harness.
//
// The trusted project's targets are the own CDP driver on Chrome for Testing and on its headless
// shell. It declares one secret, for a fill whose value the leak page copies, and keeps the default
// clock and clipboard limits. Every run reads chosen test ids just before it closes its session.
//
// Clock advances need the page's timers to be the determinism kit's virtual timers: the fixture
// pages register theirs as they load, and expect none to run until an advance.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserDriver } from "@revisum/engine";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/CreateBrowserDriver.ts";
import { rawPlan, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import { portWith, sessionWith, wrappingSessions } from "#test-support/browser/WrappingSessions.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import { FIXTURES } from "#test-support/repository.ts";
import { letterNonce } from "../unit/engine/secret-examples.ts";

const SEED = 34;
// The run's own clock start: 30 October 2026, 12:00 UTC.
export const CLOCK_START_MILLISECONDS = Date.UTC(2026, 9, 30, 12, 0, 0);
export const STEP_TIMEOUT_MILLISECONDS = 3000;
// The longest real time one advanceClock step may take.
export const MAXIMUM_ADVANCE_REAL_MILLISECONDS = 2000;

const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;


// The secret the leak page's token field is filled with, and copies.
export const COPY_SECRET = "CLIPBOARD_ACCESS_TOKEN";

// What the clipboard page's buttons copy.
export const INVITE_CODE = "Invite code: HX-4471";
export const ADDRESS_LINES = ["Ada Lovelace", "12 St James Square", "London"] as const;
export const LATE_CODE = "Late code: QZ-2290";

const FIXTURE_FOLDER = join(FIXTURES, "clock-and-clipboard-app");

const clockAndClipboardProjectFile = (origin: string) => ({
    origins: [origin],
    limits: { stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS },
    secretNames: [COPY_SECRET],
    matrix: englishMatrix(Object.values(BrowserTarget)),
});

export const advanceClock = (
    amount: number,
    unit: string,
    mode?: "runTimers" | "skipAhead",
): JsonRecord => ({
    type: "advanceClock",
    by: { amount, unit },
    ...(mode === undefined ? {} : { mode }),
});
export const expectClipboard = (
    kind: "textEquals" | "textContains" | "textExcludes",
    value: unknown,
    criterionId: string,
): JsonRecord => ({ type: "expectClipboard", assert: { kind, value }, criterionId });
export const rememberClipboard = (name: string): JsonRecord => ({
    type: "remember",
    name,
    from: { clipboard: "text" },
});
export const absent = (locator: JsonRecord, criterionId: string): JsonRecord => ({
    type: "expect",
    locator,
    assert: { kind: "absent" },
    criterionId,
});
export const frame = (locator: JsonRecord, steps: readonly unknown[]): JsonRecord => ({
    type: "frame",
    locator,
    steps,
});

export const clockPlan = (
    targetId: string,
    steps: readonly unknown[],
    fields: JsonRecord = {},
): JsonRecord =>
    rawPlan(
        {
            featureId: "CLOCK-1",
            specReference: "specs/clock-and-clipboard.md#driver",
            title: "Clock advances and clipboard checks in a browser",
        },
        targetId,
        steps,
        fields,
    );

// Personal data made fresh for one harness, which the leak page shows and copies. It begins with
// no step type, field or header name, so a leak scan's prefix check can only match the value.
type Canaries = { readonly contactName: string };

function routesFor(canaries: Canaries): ReadonlyMap<string, FixtureRoute> {
    const leaksTemplate = readFileSync(join(FIXTURE_FOLDER, "leaks.html"), "utf8");
    return new Map<string, FixtureRoute>([
        [
            "/api/late-code",
            () => ({
                headers: { "content-type": "text/plain" },
                chunks: [Buffer.from("QZ-"), Buffer.from("2290")],
                chunkPauseMilliseconds: 150,
            }),
        ],
        [
            "/leaks.html",
            () => ({
                headers: { "content-type": "text/html; charset=utf-8" },
                body: leaksTemplate.replace("CONTACT_NAME", canaries.contactName),
            }),
        ],
    ]);
}

// What the engine asked of a session, in order: 'act' and 'download' for each action, 'guard' for
// each time the driver asked the runtime guard, and 'advance-start' and 'advance-end' around
// each call of the clock port's advance.
type SessionCallRecorder = { readonly driver: BrowserDriver; readonly calls: readonly string[] };

export function recordingSessionCalls(inner: BrowserDriver): SessionCallRecorder {
    const calls: string[] = [];
    const guarded = (guard: unknown): unknown => {
        if (typeof guard !== "function") {
            return guard;
        }
        return (...guardArguments: unknown[]): unknown => {
            calls.push("guard");
            return Reflect.apply(guard, undefined, guardArguments);
        };
    };
    const driver = wrappingSessions(inner, (session) => {
        const clock: unknown = Reflect.get(session, "clock", session);
        const advance: unknown =
            typeof clock === "object" && clock !== null
                ? Reflect.get(clock, "advance", clock)
                : undefined;
        const download: unknown = Reflect.get(session, "download", session);
        const replaced: Record<string, unknown> = {
            act: (step: unknown, guard: unknown, secret: unknown): unknown => {
                calls.push("act");
                return Reflect.apply(Reflect.get(session, "act", session), session, [
                    step,
                    guarded(guard),
                    secret,
                ]);
            },
        };
        if (typeof download === "function") {
            replaced["download"] = (
                step: unknown,
                maximumBytes: unknown,
                guard: unknown,
            ): unknown => {
                calls.push("download");
                return Reflect.apply(download, session, [step, maximumBytes, guarded(guard)]);
            };
        }
        if (typeof advance === "function") {
            replaced["clock"] = portWith(clock, {
                advance: async (...advanceArguments: unknown[]): Promise<unknown> => {
                    calls.push("advance-start");
                    try {
                        return await Reflect.apply(advance, clock, advanceArguments);
                    } finally {
                        calls.push("advance-end");
                    }
                },
            });
        }
        return sessionWith(session, replaced);
    });
    return { driver, calls };
}

export type ClockHarness = BrowserHarness & { readonly canaries: Canaries };

export async function clockHarness(): Promise<ClockHarness> {
    const canaries: Canaries = { contactName: `Zqcontact${letterNonce(10)} Ellery` };
    const harness = await startBrowserHarness({
        fixtureFolder: FIXTURE_FOLDER,
        routes: routesFor(canaries),
        projectFile: clockAndClipboardProjectFile,
        seed: SEED,
        fixedTimeMilliseconds: CLOCK_START_MILLISECONDS,
        drivers: driversForTargets(Object.values(BrowserTarget)),
        planFor: clockPlan,
        readAtClose: ["input-events"],
    });
    return { ...harness, canaries };
}
