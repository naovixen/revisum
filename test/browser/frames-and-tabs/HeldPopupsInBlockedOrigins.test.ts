// A run lists an origin as blocked because something refused it. A popup to a declared origin was only
// held back, so it stays out of every run's blocked origins, while the run keeps the record that a
// popup was held. A popup to an undeclared origin is a refusal too, and is listed. The browser is real,
// and its records go through the join a run uses, then through a suite run's listing.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import type { BrowserRequestRecord, ClosedSession, EgressEvent } from "@revisum/contracts";
import { joinEgressEvents, type EgressProxy } from "@revisum/runner";
import { startedEgressProxy } from "#test-support/StartedEgressProxy.ts";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { createBrowserDriver } from "#test-support/browser/driver/CreateBrowserDriver.ts";
import { click, role } from "#test-support/browser/RawPlan.ts";
import { egressThrough } from "#test-support/browser/driver/SessionEgressForTest.ts";
import { BROWSERS } from "#test-support/browser/Browsers.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/browser/harnesses/CapabilityHarness.ts";
import { recordedReport } from "../../unit/engine/evidence/examples/EvidenceRun.ts";
import { runDeclaredSuite } from "../../unit/cli/commands/run-suite/examples/SuiteRun.ts";
import { declaredService, egressPolicy, fakeResolver } from "../../unit/runner/examples/DeclaredService.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { baseUrlOf } from "#test-support/builders/ClearRun.ts";

const OPEN_BUTTON = "Open the partner site";
const UNDECLARED_ORIGIN = "http://undeclared.invalid";
const WAIT_MILLISECONDS = 10_000;
const POLL_MILLISECONDS = 50;

type Site = { readonly origin: string; close(): Promise<void> };

async function startSite(page: (path: string) => string): Promise<Site> {
    const server: Server = createServer((incoming, response) => {
        response
            .writeHead(200, { "content-type": "text/html; charset=utf-8" })
            .end(page(new URL(incoming.url ?? "/", "http://localhost").pathname));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

let capability: CapabilityHarness;
let partner: Site;
let opener: Site;
let proxy: EgressProxy;

const openerPageTo = (popupUrl: string): string =>
    `<!doctype html><html lang="en"><title>Opener</title><h1>Opener</h1>
    <button type="button" onclick="window.open('${popupUrl}', 'partner', 'width=400,height=300')">${OPEN_BUTTON}</button></html>`;

const DECLARED_POPUP_PAGE = "/to-the-partner.html";
const UNDECLARED_POPUP_PAGE = "/to-nowhere-declared.html";

before(async () => {
    capability = await capabilityHarness(5000);
    partner = await startSite(
        () => '<!doctype html><html lang="en"><title>Partner</title><h1>Partner</h1></html>',
    );
    opener = await startSite((path) =>
        openerPageTo(
            path === UNDECLARED_POPUP_PAGE
                ? `${UNDECLARED_ORIGIN}/welcome`
                : `${partner.origin}/welcome`,
        ),
    );
    proxy = await startedEgressProxy({
        policy: egressPolicy({
            allowOrigins: [opener.origin, partner.origin],
            allowServices: ["opener-site", "partner-site"],
        }),
        services: [
            declaredService("opener-site", opener.origin, true),
            declaredService("partner-site", partner.origin, true),
        ],
        resolve: fakeResolver({}).resolve,
    });
});
after(async () => {
    await proxy.close();
    await partner.close();
    await opener.close();
    await capability.close();
});

type HeldPopup = {
    readonly records: readonly BrowserRequestRecord[];
    readonly sessionBlocked: readonly string[];
    readonly events: readonly EgressEvent[];
    readonly suiteBlocked: readonly string[] | undefined;
};

// Clicks the button that opens the popup, closes the session, and lists what each kind of run makes of
// what it saw.
async function openPopupFrom(page: string): Promise<HeldPopup> {
    const driver = createBrowserDriver({
        executablePath: BROWSERS.chrome,
        egress: egressThrough(proxy),
    });
    const opened = await driver.open(capability.target(BrowserTarget.Chrome), {
        ...capability.environment(),
        baseUrl: baseUrlOf(opener.origin),
        allowedOrigins: [opener.origin, partner.origin],
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    const session = opened.value;
    let records: readonly BrowserRequestRecord[];
    let closed: ClosedSession;
    try {
        const navigated = await session.navigate(`${opener.origin}${page}`, scriptsEnabled);
        assert.ok(navigated.ok, JSON.stringify(navigated));
        await session.act(
            capability.actionStep(click(role("button", OPEN_BUTTON))),
            allowEveryAction,
        );
        const giveUpAt = Date.now() + WAIT_MILLISECONDS;
        while (
            !session.egressRecords().some((record) => record.channel === "popup") &&
            Date.now() < giveUpAt
        ) {
            await pause(POLL_MILLISECONDS);
        }
    } finally {
        closed = await session.close();
        records = session.egressRecords();
    }
    assert.ok(closed.blockedOrigins.ok, JSON.stringify(closed.blockedOrigins));
    const events = joinEgressEvents(records, proxy.decisions());
    const { result } = await runDeclaredSuite({
        behaviour: {
            report: recordedReport("passing-with-criteria"),
            exitCode: 0,
            egressEvents: events,
        },
    });
    return {
        records,
        sessionBlocked: closed.blockedOrigins.value,
        events,
        suiteBlocked: result.blockedOrigins,
    };
}

const popupsAmong = <Entry extends { readonly channel: string }>(
    entries: readonly Entry[],
): readonly Entry[] => entries.filter((entry) => entry.channel === "popup");

describe("Using a run's record of a popup", () => {
    describe("given a page that opens a popup to a declared origin", () => {
        describe("when the driver holds the popup back", () => {
            let popup: HeldPopup;
            before(async () => {
                popup = await openPopupFrom(DECLARED_POPUP_PAGE);
            });

            test("then it should stay out of a suite run's blocked origins", () => {
                assert.deepEqual(popup.suiteBlocked, []);
            });

            test("then it should stay out of the session's blocked origins", () => {
                assert.deepEqual(popup.sessionBlocked, []);
            });

            test("then it should show in the run's events as held", () => {
                assert.deepEqual(popupsAmong(popup.events), [
                    { origin: partner.origin, channel: "popup", decision: "held" },
                ]);
            });

            test("then it should stay in the browser's records", () => {
                assert.deepEqual(popupsAmong(popup.records), [
                    { origin: partner.origin, channel: "popup" },
                ]);
            });
        });
    });

    describe("given a page that opens a popup to an undeclared origin", () => {
        describe("when the driver holds the popup back", () => {
            let popup: HeldPopup;
            before(async () => {
                popup = await openPopupFrom(UNDECLARED_POPUP_PAGE);
            });

            test("then it should be in a suite run's blocked origins", () => {
                assert.deepEqual(popup.suiteBlocked, [UNDECLARED_ORIGIN]);
            });

            test("then it should be in the session's blocked origins", () => {
                assert.deepEqual(popup.sessionBlocked, [UNDECLARED_ORIGIN]);
            });

            test("then it should show in the run's events as blocked", () => {
                assert.deepEqual(popupsAmong(popup.events), [
                    { origin: UNDECLARED_ORIGIN, channel: "popup", decision: "blocked" },
                ]);
            });
        });
    });
});
