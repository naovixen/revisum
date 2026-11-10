// A host run must keep a page's own tab, and any popup it opens, from an undeclared address, through
// the session's egress proxy as a host run builds it. Fetch only holds a navigation's request, which
// leaves room for Chrome to open the connection first, so only the undeclared server's own record can
// show that nothing got through. Each page is tried
// against real servers on loopback: the page's own origin, a declared origin on another site, and an
// undeclared one on a third. The same page aimed at the declared origin is the counter-example.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import {
    startBrowserHarness,
    type BrowserHarness,
    type BrowserRun,
} from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { click, navigate, testId, textEquals } from "#test-support/browser/RawPlan.ts";
import {
    FIXED_TIME_MILLISECONDS,
    SEED,
    capabilityPlan,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";
import { onTarget } from "#test-support/TestTier.ts";
import {
    ATTEMPT_SETTLED,
    ATTEMPT_STATE,
    SETTLE_MILLISECONDS,
    attemptPage,
    type ChannelAddress,
} from "./support/EgressChannels.ts";
import { hostBrowserDrivers } from "./support/HostBrowserDrivers.ts";
import {
    Arrival,
    requestArrival,
    startRecordingOrigin,
    type RecordingOrigin,
} from "./support/StartRecordingOrigin.ts";

const LEAVE_CONTROL = "leave";
const SCRIPTED_DEPARTURE_MILLISECONDS = SETTLE_MILLISECONDS + 200;
// Long enough for a departure to land before the run closes the page.
const DEPARTURE_HOLD_MILLISECONDS = 1_500;
// Long enough for a held popup to ask for its first page, which it is given a second to do.
const POPUP_HELD_MILLISECONDS = 1_500;

// A way a page can take its own tab to an address. Each one acts only after the page has settled, so
// a plan has something to check first.
type Departure = {
    // Where the departure's pages are served, as one path segment.
    readonly name: string;
    // Finishes the sentence "a page that".
    readonly attempt: string;
    // What the address records when the departure gets through.
    readonly arrival: string;
    readonly isStartedByClick: boolean;
    page(address: ChannelAddress): string;
};

const DEPARTURES: readonly Departure[] = [
    {
        name: "scripted-navigation",
        attempt: "navigates its own tab from a script",
        arrival: requestArrival("/navigated"),
        isStartedByClick: false,
        page: ({ origin }) =>
            `<script>setTimeout(() => { location.href = ${JSON.stringify(`${origin}/navigated`)}; }, ${SCRIPTED_DEPARTURE_MILLISECONDS});</script>`,
    },
    {
        name: "link-click",
        attempt: "has a link that is clicked",
        arrival: requestArrival("/linked"),
        isStartedByClick: true,
        page: ({ origin }) => `<a data-testid="${LEAVE_CONTROL}" href="${origin}/linked">Next</a>`,
    },
    {
        name: "form-post",
        attempt: "has a form that is posted",
        arrival: requestArrival("/posted", "POST"),
        isStartedByClick: true,
        page: ({ origin }) =>
            `<form method="post" action="${origin}/posted"><button data-testid="${LEAVE_CONTROL}">Next</button></form>`,
    },
];

const popupButtonTo = ({ origin }: ChannelAddress): string =>
    `<button data-testid="${LEAVE_CONTROL}" onclick="window.open('${origin}/popup')">Next</button>`;

const AddressKind = { Undeclared: "undeclared", Declared: "declared" } as const;
type AddressKind = (typeof AddressKind)[keyof typeof AddressKind];

const departurePath = (departure: Departure, kind: AddressKind): string =>
    `/${departure.name}/${kind}.html`;
const popupPath = (kind: AddressKind): string => `/popup/${kind}.html`;

const htmlRoute =
    (attempt: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: attemptPage(attempt),
    });

let undeclared: RecordingOrigin;
let declared: RecordingOrigin;
let harness: BrowserHarness;

before(async () => {
    undeclared = await startRecordingOrigin("127.0.0.2");
    declared = await startRecordingOrigin("127.0.0.3");
    const departureRoutes = (kind: AddressKind, address: RecordingOrigin) =>
        DEPARTURES.map(
            (departure) =>
                [departurePath(departure, kind), htmlRoute(departure.page(address))] as const,
        );
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "sites", "capability-app"),
        routes: new Map<string, FixtureRoute>([
            ...departureRoutes(AddressKind.Undeclared, undeclared),
            ...departureRoutes(AddressKind.Declared, declared),
            [popupPath(AddressKind.Undeclared), htmlRoute(popupButtonTo(undeclared))],
            [popupPath(AddressKind.Declared), htmlRoute(popupButtonTo(declared))],
        ]),
        projectFile: (origin) => ({
            origins: [origin, declared.origin],
            limits: { stepTimeoutMilliseconds: 10_000, maximumSteps: 20 },
            matrix: englishMatrix(Object.values(BrowserTarget)),
        }),
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        drivers: hostBrowserDrivers(Object.values(BrowserTarget)),
        planFor: capabilityPlan,
    });
});
after(async () => {
    await harness.close();
    await declared.close();
    await undeclared.close();
});

const stepsOnPage = (path: string): readonly unknown[] => [
    navigate(path),
    textEquals(testId(ATTEMPT_STATE), ATTEMPT_SETTLED, "leaving.attempt-settled"),
];

const stepsClickingPopup = (kind: AddressKind): readonly unknown[] => [
    ...stepsOnPage(popupPath(kind)),
    click(testId(LEAVE_CONTROL)),
];

// A page that has left may well fail the step that took it away, so these runs' state says nothing.
async function runDeparture(departure: Departure, kind: AddressKind): Promise<BrowserRun> {
    undeclared.forgetArrivals();
    declared.forgetArrivals();
    const clicks = departure.isStartedByClick ? [click(testId(LEAVE_CONTROL))] : [];
    return harness.runSteps(
        BrowserTarget.Chrome,
        [...stepsOnPage(departurePath(departure, kind)), ...clicks],
        {
            read: [],
            beforePageRead: async () => {
                await pause(DEPARTURE_HOLD_MILLISECONDS);
            },
        },
    );
}

const isConnection = (arrival: string): boolean => arrival === Arrival.Connection;

const showsBlocked = (ran: BrowserRun, hostname: string): boolean =>
    ran.result.blockedOrigins.some((origin) => origin.includes(hostname));

describe("Using a run on the host", () => {
    describe("given a run on Chrome", () => {
        for (const departure of DEPARTURES) {
            describe(`and a page that ${departure.attempt}`, () => {
                describe("when the address it goes to is undeclared", () => {
                    let ran: BrowserRun;
                    let arrivals: readonly string[];
                    before(async () => {
                        ran = await runDeparture(departure, AddressKind.Undeclared);
                        arrivals = undeclared.arrivals();
                    });

                    test("then it should send that address nothing", () => {
                        const sent = arrivals.filter((arrival) => !isConnection(arrival));
                        assert.deepEqual(sent, []);
                    });

                    test("then it should open no connection to that address", () => {
                        assert.deepEqual(arrivals.filter(isConnection), []);
                    });

                    test("then it should show the attempt in the run's blocked origins", () => {
                        assert.ok(
                            showsBlocked(ran, undeclared.hostname),
                            `blocked origins: ${JSON.stringify(ran.result.blockedOrigins)}`,
                        );
                    });
                });

                describe("when the address it goes to is declared", () => {
                    let arrivals: readonly string[];
                    before(async () => {
                        await runDeparture(departure, AddressKind.Declared);
                        arrivals = declared.arrivals();
                    });

                    test("then it should connect to that address, so the undeclared one's silence means something", () => {
                        assert.ok(
                            arrivals.includes(Arrival.Connection),
                            `arrived: ${JSON.stringify(arrivals)}`,
                        );
                    });

                    test("then it should arrive at that address", () => {
                        assert.ok(
                            arrivals.includes(departure.arrival),
                            `arrived: ${JSON.stringify(arrivals)}`,
                        );
                    });
                });
            });
        }
    });

    for (const targetId of Object.values(BrowserTarget)) {
        describe(`given a run on ${targetId}`, onTarget(targetId), () => {
            describe("and a page with a button that opens a popup", () => {
                describe("when the popup's address is undeclared", () => {
                    let ran: BrowserRun;
                    let arrivals: readonly string[];
                    before(async () => {
                        undeclared.forgetArrivals();
                        ran = await harness.runSteps(
                            targetId,
                            stepsClickingPopup(AddressKind.Undeclared),
                        );
                        arrivals = undeclared.arrivals();
                    });

                    test("then it should fail the step that opened it", () => {
                        assert.equal(ran.result.steps.at(-1)?.code, "unsupported-step");
                    });

                    test("then it should send that address nothing", () => {
                        const sent = arrivals.filter((arrival) => !isConnection(arrival));
                        assert.deepEqual(sent, []);
                    });

                    test("then it should show the popup in the run's blocked origins", () => {
                        assert.ok(
                            showsBlocked(ran, undeclared.hostname),
                            `blocked origins: ${JSON.stringify(ran.result.blockedOrigins)}`,
                        );
                    });

                    test("then it should show the popup in the session's blocked origins", async () => {
                        let blocked: readonly string[] = [];
                        await harness.runSteps(
                            targetId,
                            stepsClickingPopup(AddressKind.Undeclared),
                            {
                                read: [],
                                beforePageRead: async (session) => {
                                    await pause(POPUP_HELD_MILLISECONDS);
                                    const noted = session.recordsSoFar().blockedOrigins;
                                    assert.ok(noted.ok, JSON.stringify(noted));
                                    blocked = noted.value;
                                },
                            },
                        );
                        assert.ok(
                            blocked.includes(undeclared.origin),
                            `blocked origins: ${JSON.stringify(blocked)}`,
                        );
                    });
                });

                describe("when the popup's address is declared", () => {
                    let ran: BrowserRun;
                    before(async () => {
                        ran = await harness.runSteps(
                            targetId,
                            stepsClickingPopup(AddressKind.Declared),
                        );
                    });

                    test("then it should fail the step that opened it", () => {
                        assert.equal(ran.result.steps.at(-1)?.code, "unsupported-step");
                    });

                    test("then it should block nothing", () => {
                        assert.deepEqual(ran.result.blockedOrigins, []);
                    });
                });
            });
        });
    }
});
