// A download step lets the browser save its one file, then has downloads refused again. If that last
// part fails, the step has still got its file, and must keep what it found: what went wrong afterwards
// is for the session's close to report, as any other clean-up that failed.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import type { DriverSession } from "@revisum/driver-cdp";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { testId } from "#test-support/browser/RawPlan.ts";
import { startRelayedDriver, type RelayedDriver } from "#test-support/browser/RelayedDriver.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import { downloadStep } from "#test-support/session-contract/SessionUnderTest.ts";

shareBrowserInThisFile();

const STEP_TIMEOUT_MILLISECONDS = 4000;
const TARGET = BrowserTarget.Chrome;
const PAGE = "/start.html";
const LINK = "link-to-the-file";
const MAXIMUM_BYTES = 1024;
const WHY_THE_BROWSER_REFUSED = "the browser would not change its download behaviour";

const ROUTES = new Map<string, FixtureRoute>([
    [
        PAGE,
        () => ({
            headers: { "content-type": "text/html; charset=utf-8" },
            body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Start</title></head><body>
      <main><a href="/report.csv" data-testid="${LINK}">Report</a></main>
    </body></html>`,
        }),
    ],
    [
        "/report.csv",
        () => ({
            headers: {
                "content-type": "text/csv",
                "content-disposition": 'attachment; filename="report.csv"',
            },
            body: "name\nmarker\n",
        }),
    ],
]);

describe("Using a download step in a real browser", () => {
    let harness: CapabilityHarness;
    let relayed: RelayedDriver;

    before(async () => {
        harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
    });
    after(async () => {
        await harness.close();
    });
    beforeEach(async () => {
        relayed = await startRelayedDriver();
    });
    afterEach(async () => {
        await relayed.relay.close();
    });

    const onOpenSession = async (): Promise<DriverSession> => {
        const opened = await relayed.driver.open(harness.target(TARGET), harness.environment());
        assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
        assert.ok(
            (await opened.value.navigate(harness.url(PAGE), scriptsEnabled)).ok,
            `${PAGE} loads`,
        );
        return opened.value;
    };

    describe("given a file the step has saved", () => {
        describe("and downloads that cannot be refused again afterwards", () => {
            describe("when the step ends and the session closes", () => {
                test("then it should keep the file, and report the refusal at the close", async () => {
                    const session = await onOpenSession();
                    relayed.relay.tamperWith({
                        method: "Browser.setDownloadBehavior",
                        applies: ({ parameters }) => parameters["behavior"] === "deny",
                        change: { refusal: WHY_THE_BROWSER_REFUSED },
                    });
                    const outcome = await session.download(
                        downloadStep(testId(LINK)),
                        MAXIMUM_BYTES,
                        allowEveryAction,
                    );
                    const closed = await session.close();
                    assert.ok(outcome.ok, JSON.stringify(outcome));
                    assert.equal(outcome.value.fileName, "report.csv");
                    assert.ok(relayed.relay.timesTampered() > 0, "the refusal was asked for");
                    assert.match(closed.closeFailure ?? "", new RegExp(WHY_THE_BROWSER_REFUSED));
                });
            });
        });

        describe("and downloads that are refused again afterwards", () => {
            describe("when the step ends and the session closes", () => {
                test("then it should keep the file, and the close should report nothing", async () => {
                    const session = await onOpenSession();
                    const outcome = await session.download(
                        downloadStep(testId(LINK)),
                        MAXIMUM_BYTES,
                        allowEveryAction,
                    );
                    const closed = await session.close();
                    assert.ok(outcome.ok, JSON.stringify(outcome));
                    assert.equal(closed.closeFailure, null);
                });
            });
        });
    });
});
