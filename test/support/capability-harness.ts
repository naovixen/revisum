// Shared setup for the CDP driver's capability tests: the capability fixture app, a trusted project
// whose targets are the own CDP driver on Chrome for Testing and on its headless shell, with helpers
// to open sessions directly and watch the processes a driver started.
//
// The project declares one upload file, upload-note.txt, which lives in fixtures/capability-uploads/
// (the project's fixtures folder); the CDP driver is told where that folder is.
import assert from "node:assert/strict";
import { join } from "node:path";
import type { ClosedSession } from "@revisum/contracts";
import type { DriverSession, OwnBrowserDriver } from "@revisum/driver-cdp";
import {
    defaultRedactor,
    type BrowserDriver,
    type Session,
    type SessionEnvironment,
    type Target,
} from "@revisum/engine";
import { startBrowserHarness, type BrowserHarness } from "./browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "./browser/BrowserTarget.ts";
import {
    createBrowserDriver,
    driverForTarget,
    driversForTargets,
} from "./browser/CreateBrowserDriver.ts";
import { rawPlan, testId, type JsonRecord } from "./browser/RawPlan.ts";
import { driverWith, sessionWith } from "./browser/WrappingSessions.ts";
import type { FixtureRoute } from "./fixture-server.ts";
import { processTree, stillRunning, type RunningProcess } from "./process-tree.ts";
import { FIXTURES } from "./repository.ts";
import { expectOneElement } from "./browser/ExpectOneElement.ts";
import { baseUrlOf } from "./policy-clearance.ts";

export const SEED = 11;
export const FIXED_TIME_MILLISECONDS = Date.UTC(2026, 9, 29, 9, 0, 0);

export const UPLOAD_FIXTURE = "upload-note.txt";
const UPLOAD_FOLDER = join(FIXTURES, "capability-uploads");
export const UPLOAD_CONTENT = "Upload fixture note: twelve green bottles.";

const capabilityProjectFile = (origin: string, stepTimeoutMilliseconds: number) => ({
    origins: [origin],
    // A capability test repeats its steps up to 20 times in one plan, in one browser.
    limits: { stepTimeoutMilliseconds, maximumSteps: 400 },
    fixtures: [UPLOAD_FIXTURE],
    matrix: englishMatrix(Object.values(BrowserTarget)),
});

// The CDP driver for one executable, told where the project's upload files are.
export const capabilityCdpDriver = (executablePath: string): OwnBrowserDriver =>
    createBrowserDriver({ executablePath, fixturesFolder: UPLOAD_FOLDER });

export const capabilityDrivers = (): ReadonlyMap<string, BrowserDriver> =>
    driversForTargets(Object.values(BrowserTarget), { fixturesFolder: UPLOAD_FOLDER });

const isBrowserTarget = (targetId: string): targetId is BrowserTarget =>
    Object.values<string>(BrowserTarget).includes(targetId);

// The own CDP driver that serves a target, by the target's adapter.
export function ownDriverFor(targetId: string): OwnBrowserDriver {
    assert.ok(isBrowserTarget(targetId), `${targetId} is not a CDP target`);
    return driverForTarget(targetId, { fixturesFolder: UPLOAD_FOLDER });
}

// A plan for one target with the given steps.
export const capabilityPlan = (
    targetId: string,
    steps: readonly unknown[],
    fields: JsonRecord = {},
): JsonRecord =>
    rawPlan(
        {
            featureId: "CAPABILITY-1",
            specReference: "specs/capabilities.md#driver",
            title: "Driver capability",
        },
        targetId,
        steps,
        fields,
    );

// What a watched driver saw of one session it opened.
type WatchedSession = {
    readonly processId: number;
    // Every process below the browser just before close() was called.
    processesBeforeClose: readonly RunningProcess[];
    // Those of them still running at the moment close() returned.
    stillRunningAfterClose: readonly RunningProcess[];
    closeCalls: number;
    closeError: unknown;
    // What `beforeClose` read from the page, if anything.
    readBeforeClose: string | null;
};

export type WatchedDriver = {
    readonly driver: BrowserDriver;
    readonly sessions: readonly WatchedSession[];
    // Resolves with the session's browser process id as soon as a session is open.
    opened(): Promise<number>;
};

// Wraps an own CDP driver so a test can see the browser process of each session it opens, and
// what is still running when its close() returns. `beforeClose` may read the page first.
export function watchedDriver(
    inner: OwnBrowserDriver,
    beforeClose?: (session: DriverSession) => Promise<string>,
): WatchedDriver {
    const sessions: WatchedSession[] = [];
    let announce: (processId: number) => void = () => undefined;
    const firstOpen = new Promise<number>((resolve) => {
        announce = resolve;
    });
    const watch = (session: DriverSession): DriverSession => {
        const watched: WatchedSession = {
            processId: session.processId,
            processesBeforeClose: [],
            stillRunningAfterClose: [],
            closeCalls: 0,
            closeError: null,
            readBeforeClose: null,
        };
        sessions.push(watched);
        announce(session.processId);
        const close = async (): Promise<ClosedSession> => {
            watched.closeCalls += 1;
            if (beforeClose !== undefined) {
                try {
                    watched.readBeforeClose = await beforeClose(session);
                } catch (error) {
                    watched.readBeforeClose = `read failed: ${String(error)}`;
                }
            }
            watched.processesBeforeClose = processTree(session.processId);
            const closed = await session.close();
            if (closed.closeFailure !== null) {
                watched.closeError = new Error(closed.closeFailure);
            }
            watched.stillRunningAfterClose = stillRunning(watched.processesBeforeClose);
            return closed;
        };
        return sessionWith(session, { close });
    };
    const driver = driverWith(inner, {
        open: async (target: Target, environment: SessionEnvironment) => {
            const opened = await inner.open(target, environment);
            return opened.ok ? { ok: true as const, value: watch(opened.value) } : opened;
        },
    });
    return { driver, sessions, opened: () => firstOpen };
}

export type CapabilityHarness = BrowserHarness & {
    readonly stepTimeoutMilliseconds: number;
    environment(): SessionEnvironment;
    // Opens a session on the target's driver directly, outside a run.
    open(targetId: string): Promise<Session>;
    // Opens a session on a target of the own CDP driver, with its process id and page evaluation.
    openOwn(targetId: string): Promise<DriverSession>;
};

export async function capabilityHarness(
    stepTimeoutMilliseconds = 2000,
    routes: ReadonlyMap<string, FixtureRoute> = new Map(),
): Promise<CapabilityHarness> {
    const drivers = capabilityDrivers();
    const harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "capability-app"),
        routes,
        projectFile: (origin) => capabilityProjectFile(origin, stepTimeoutMilliseconds),
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        drivers,
        planFor: capabilityPlan,
    });
    const environment = (): SessionEnvironment => ({
        baseUrl: baseUrlOf(harness.origin),
        allowedOrigins: harness.project.origins,
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        sensitiveSelectors: defaultRedactor().selectors,
        timeoutMilliseconds: stepTimeoutMilliseconds,
    });
    return {
        ...harness,
        stepTimeoutMilliseconds,
        environment,
        async open(targetId) {
            const target = harness.target(targetId);
            const driver = drivers.get(target.adapter);
            assert.ok(driver !== undefined, `no driver for ${target.adapter}`);
            const opened = await driver.open(target, environment());
            assert.ok(
                opened.ok,
                `the session opens: ${opened.ok ? "" : JSON.stringify(opened.error)}`,
            );
            return opened.value;
        },
        async openOwn(targetId) {
            const opened = await ownDriverFor(targetId).open(
                harness.target(targetId),
                environment(),
            );
            assert.ok(
                opened.ok,
                `the session opens: ${opened.ok ? "" : JSON.stringify(opened.error)}`,
            );
            return opened.value;
        },
    };
}

// The text of the one element a test id names, read through the session's own probe.
export async function shownText(
    harness: CapabilityHarness,
    session: Session,
    id: string,
): Promise<string> {
    return expectOneElement(await session.probe(harness.locator(testId(id)), null)).text;
}
