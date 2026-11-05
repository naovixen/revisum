// What makes sharing a browser between a file's tests safe: nothing one run leaves behind reaches
// the next, and a session a failed test left open costs only that test. Both browsers are covered,
// each one's two runs on one process.
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import type { OwnBrowserDriver } from "@revisum/driver-cdp";
import type { BrowserDriver, SessionEnvironment, Target } from "@revisum/engine";
import type { BrowserRun } from "#test-support/browser/BrowserHarness.ts";
import { ADAPTER_OF_TARGET, BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { click, navigate, role, testId, textEquals } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { driverWith } from "#test-support/browser/WrappingSessions.ts";
import {
    capabilityHarness,
    capabilityPlan,
    ownDriverFor,
    type CapabilityHarness,
} from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import { endAtOnce, isRunning } from "#test-support/process-tree.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

shareBrowserInThisFile();

const TRACE_MARK = "left-behind";
const LEAVE_TRACES_PATH = "/leave-traces.html";
const READ_TRACES_PATH = "/read-traces.html";
const WORKER_PATH = `/${TRACE_MARK}-worker.js`;
const POPUP_PATH = `/${TRACE_MARK}-popup.html`;
const DOWNLOAD_PATH = `/${TRACE_MARK}-report.csv`;
const EXIT_WAIT_MILLISECONDS = 5000;
const EXIT_POLL_MILLISECONDS = 20;

const htmlPage =
    (body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><title>Traces</title><main>${body}</main></html>`,
    });

const LEAVE_TRACES_PAGE = `
    <p data-testid="planted">waiting</p>
    <button type="button" id="open-both">Open the report</button>
    <script>
      document.cookie = "${TRACE_MARK}=yes; path=/; max-age=3600";
      localStorage.setItem("${TRACE_MARK}", "yes");
      navigator.serviceWorker.register("${WORKER_PATH}")
        .then(() => navigator.serviceWorker.ready)
        .then(() => { document.querySelector('[data-testid="planted"]').textContent = "planted"; });
      document.getElementById("open-both").addEventListener("click", () => {
        window.open("${POPUP_PATH}");
        const link = document.createElement("a");
        link.href = "${DOWNLOAD_PATH}";
        link.download = "report.csv";
        document.body.append(link);
        link.click();
      });
    </script>`;

const READ_TRACES_PAGE = `
    <p data-testid="cookie-shown">waiting</p>
    <p data-testid="storage-shown">waiting</p>
    <p data-testid="workers-shown">waiting</p>
    <script>
      const show = (id, value) => { document.querySelector('[data-testid="' + id + '"]').textContent = value; };
      show("cookie-shown", document.cookie === "" ? "none" : document.cookie);
      show("storage-shown", localStorage.getItem("${TRACE_MARK}") ?? "none");
      navigator.serviceWorker.getRegistrations().then((found) => show("workers-shown", String(found.length)));
    </script>`;

const tracesShown = (cookie: string, storage: string, workers: string, name: string) => [
    textEquals(testId("cookie-shown"), cookie, `${name}.cookie`),
    textEquals(testId("storage-shown"), storage, `${name}.storage`),
    textEquals(testId("workers-shown"), workers, `${name}.workers`),
];

const RUN_LEAVING_TRACES = [
    navigate(LEAVE_TRACES_PATH),
    textEquals(testId("planted"), "planted", "traces.planted"),
    navigate(READ_TRACES_PATH),
    ...tracesShown(`${TRACE_MARK}=yes`, "yes", "1", "traces.seen-by-their-own-run"),
    navigate(LEAVE_TRACES_PATH),
    click(role("button", "Open the report")),
];
const RUN_READING_TRACES = [
    navigate(READ_TRACES_PATH),
    ...tracesShown("none", "none", "0", "traces.seen-by-the-next-run"),
];

// A driver that notes the browser process of each session it opens.
function notingProcesses(inner: OwnBrowserDriver) {
    const processIds: number[] = [];
    const driver: BrowserDriver = driverWith(inner, {
        open: async (target: Target, environment: SessionEnvironment) => {
            const opened = await inner.open(target, environment);
            if (opened.ok) {
                processIds.push(opened.value.processId);
            }
            return opened;
        },
    });
    return { driver, processIds };
}

describe("Using a browser that a test file shares", () => {
    let harness: CapabilityHarness;
    const cookiesSentToReader: string[] = [];

    before(async () => {
        harness = await capabilityHarness(
            undefined,
            new Map<string, FixtureRoute>([
                [LEAVE_TRACES_PATH, htmlPage(LEAVE_TRACES_PAGE)],
                [
                    READ_TRACES_PATH,
                    (request) => {
                        cookiesSentToReader.push(request.cookie);
                        return htmlPage(READ_TRACES_PAGE)(request);
                    },
                ],
                [WORKER_PATH, () => ({ headers: { "content-type": "text/javascript" }, body: "" })],
                [POPUP_PATH, htmlPage("<p>A popup</p>")],
                [
                    DOWNLOAD_PATH,
                    () => ({
                        headers: {
                            "content-type": "text/csv",
                            "content-disposition": 'attachment; filename="report.csv"',
                        },
                        // Slow, so the download is still arriving when the run ends.
                        chunks: [Buffer.from("a,b\n"), Buffer.from("1,2\n"), Buffer.from("3,4\n")],
                        chunkPauseMilliseconds: 500,
                    }),
                ],
            ]),
        );
    });
    after(async () => {
        await harness.close();
    });

    for (const target of Object.values(BrowserTarget)) {
        describe(`given a run on ${target} that set a cookie, storage and a service worker`, () => {
            describe("and ended on a click that opened a popup and started a download", () => {
                describe("when another run follows on the same browser", () => {
                    let runLeaving: BrowserRun;
                    let runReading: BrowserRun;
                    let processIds: readonly number[];

                    before(async () => {
                        const noted = notingProcesses(ownDriverFor(target));
                        const drivers = new Map([[ADAPTER_OF_TARGET[target], noted.driver]]);
                        const runSteps = (steps: readonly unknown[]) =>
                            harness.run(harness.plan(capabilityPlan(target, steps)), target, {
                                drivers,
                            });
                        cookiesSentToReader.length = 0;
                        runLeaving = await runSteps(RUN_LEAVING_TRACES);
                        runReading = await runSteps(RUN_READING_TRACES);
                        processIds = noted.processIds;
                    });

                    test("then it should have run both on one browser process", () => {
                        assert.equal(processIds.length, 2);
                        assert.equal(processIds[0], processIds[1]);
                    });

                    test("then it should have shown the first run its own traces", () => {
                        const outcomes = runLeaving.result.steps.map((step) => step.outcome);
                        assert.deepEqual(
                            outcomes.slice(0, -1),
                            outcomes.slice(0, -1).map(() => "passed"),
                            JSON.stringify(runLeaving.result.steps),
                        );
                        assert.equal(cookiesSentToReader[0], `${TRACE_MARK}=yes`);
                    });

                    test("then it should have stopped the first run at its popup", () => {
                        assert.equal(runLeaving.result.state, "Failed");
                        assert.equal(runLeaving.result.steps.at(-1)?.code, "unsupported-step");
                    });

                    test("then it should show the second run no cookie, storage or worker", () => {
                        assert.equal(
                            runReading.result.state,
                            "Passed",
                            JSON.stringify(runReading.result.steps),
                        );
                        assert.equal(cookiesSentToReader[1], "");
                    });

                    test("then it should keep the popup and download out of the second run's results", () => {
                        const results = JSON.stringify([
                            runReading.result,
                            runReading.events.read(),
                            runReading.audit.recorded,
                            runReading.store.references(),
                        ]);
                        assert.equal(results.includes(TRACE_MARK), false, results);
                        assert.deepEqual(runReading.result.blockedOrigins, []);
                        assert.equal(runReading.requestedPaths.includes(POPUP_PATH), false);
                        assert.equal(runReading.requestedPaths.includes(DOWNLOAD_PATH), false);
                    });
                });
            });
        });
    }

    const openSession = async (driver: OwnBrowserDriver) => {
        const target = harness.target(BrowserTarget.Chrome);
        const opened = await driver.open(target, harness.environment());
        assert.ok(opened.ok, JSON.stringify(opened));
        return opened.value;
    };

    describe("given a session that a failed test left open", () => {
        describe("when the next session opens", () => {
            test("then it should run on a new browser and end the one left behind", async () => {
                const driver = ownDriverFor(BrowserTarget.Chrome);
                const left = await openSession(driver);
                const next = await openSession(driver);
                try {
                    assert.notEqual(next.processId, left.processId);
                    assert.equal(isRunning(left.processId), false);
                    assert.ok(
                        (await next.navigate(harness.url(READ_TRACES_PATH), scriptsEnabled)).ok,
                    );
                } finally {
                    await next.close();
                }
            });
        });
    });

    describe("given a browser that has died", () => {
        describe("when the next session opens", () => {
            test("then it should run on a new browser", async () => {
                const driver = ownDriverFor(BrowserTarget.Chrome);
                const first = await openSession(driver);
                await first.close();
                endAtOnce(first.processId);
                const giveUpAt = Date.now() + EXIT_WAIT_MILLISECONDS;
                while (isRunning(first.processId) && Date.now() < giveUpAt) {
                    await pause(EXIT_POLL_MILLISECONDS);
                }
                const next = await openSession(driver);
                try {
                    assert.notEqual(next.processId, first.processId);
                    assert.ok(
                        (await next.navigate(harness.url(READ_TRACES_PATH), scriptsEnabled)).ok,
                    );
                } finally {
                    await next.close();
                }
            });
        });
    });
});
