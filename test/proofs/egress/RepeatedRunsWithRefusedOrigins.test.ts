// A request sent as a run ends races the session's close, so which origins a run refuses can differ from
// one run to the next. The result hash leaves that list out, so it must repeat regardless; the evidence
// hash covers the list, so it follows whatever each run saw. This repeats one plan against a page that
// asks undeclared origins by fetch, WebSocket and a worker, and then, at the moment the run's last check
// can pass, by fetches staggered around it. The names are reserved for examples, and an undeclared name is
// refused before it is looked up, so nothing leaves the machine.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { navigate, testId, textEquals } from "#test-support/browser/RawPlan.ts";
import {
    FIXED_TIME_MILLISECONDS,
    SEED,
    capabilityPlan,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";
import { evidenceHashOf, expectedEvidenceHash } from "#test-support/ExpectedEvidenceHash.ts";
import { determinismRuns, onTarget } from "#test-support/TestTier.ts";
import type { RunResult } from "@revisum/engine";
import {
    ATTEMPT_SETTLED,
    ATTEMPT_STATE,
    SETTLE_MILLISECONDS,
    attemptPage,
} from "./support/EgressChannels.ts";
import { hostBrowserDrivers } from "./support/HostBrowserDrivers.ts";

const LEAST_RUNS = 12;
const RUNS = Math.max(LEAST_RUNS, determinismRuns());
const CONTROL_RUNS = 2;

const PAGE_PATH = "/asks-undeclared-origins.html";
const WORKER_PATH = "/asks-undeclared-origins.js";

const FETCH_NAME = "fetch-refused.example";
const WEBSOCKET_NAME = "websocket-refused.example";
const WORKER_NAME = "worker-refused.example";
const EARLY_NAMES = [FETCH_NAME, WEBSOCKET_NAME, WORKER_NAME];

// Timers of the same delay fire in the order they were set, so the first of these fires just before the
// page says it has settled, and the rest straddle the run's last check and the session's close.
const LATE_DELAYS_MILLISECONDS = [0, 1, 2, 4, 8, 16, 32, 64, 128, 256];
const lateName = (delay: number): string => `late-${delay}-refused.example`;

const noCorsFetch = (name: string): string =>
    `fetch(${JSON.stringify(`http://${name}/`)}, { mode: "no-cors" }).catch(() => undefined);`;

const ASKING_PAGE = attemptPage(`<script>
      ${noCorsFetch(FETCH_NAME)}
      new WebSocket(${JSON.stringify(`ws://${WEBSOCKET_NAME}/socket`)});
      new Worker(${JSON.stringify(WORKER_PATH)});
      ${LATE_DELAYS_MILLISECONDS.map(
          (delay) =>
              `setTimeout(() => { ${noCorsFetch(lateName(delay))} }, ${SETTLE_MILLISECONDS + delay});`,
      ).join("\n      ")}
    </script>`);
const QUIET_PAGE = attemptPage("");

const STEPS: readonly unknown[] = [
    navigate(PAGE_PATH),
    textEquals(testId(ATTEMPT_STATE), ATTEMPT_SETTLED, "repeated-runs.attempt-settled"),
];
const STEPS_WITH_ONE_MORE_CHECK: readonly unknown[] = [
    ...STEPS,
    textEquals(testId(ATTEMPT_STATE), ATTEMPT_SETTLED, "repeated-runs.attempt-stays-settled"),
];

type RunMeasure = {
    readonly result: RunResult;
    readonly resultHash: string;
    readonly blockedOrigins: readonly string[];
};

let harness: BrowserHarness;
let pageServed = ASKING_PAGE;

before(async () => {
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "sites", "capability-app"),
        routes: new Map<string, FixtureRoute>([
            [
                PAGE_PATH,
                () => ({
                    headers: { "content-type": "text/html; charset=utf-8" },
                    body: pageServed,
                }),
            ],
            [
                WORKER_PATH,
                () => ({
                    headers: { "content-type": "text/javascript" },
                    body: noCorsFetch(WORKER_NAME),
                }),
            ],
        ]),
        projectFile: (origin) => ({
            origins: [origin],
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
});

async function repeatRuns(
    targetId: BrowserTarget,
    count: number,
    steps: readonly unknown[] = STEPS,
): Promise<readonly RunMeasure[]> {
    const measures: RunMeasure[] = [];
    for (let index = 0; index < count; index += 1) {
        const { result } = await harness.runSteps(targetId, steps);
        assert.equal(result.state, "Passed", JSON.stringify(result));
        measures.push({
            result,
            resultHash: result.resultHash,
            blockedOrigins: result.blockedOrigins,
        });
    }
    return measures;
}

const showsName = (measure: RunMeasure, name: string): boolean =>
    measure.blockedOrigins.some((origin) => origin.includes(name));

// How many runs gave each hash, what those runs refused, and how many runs showed each late request.
function summaryOf(measures: readonly RunMeasure[]): string {
    const hashes = [...new Set(measures.map((measure) => measure.resultHash))];
    const perHash = hashes.map((hash) => {
        const runs = measures.filter((measure) => measure.resultHash === hash);
        return `${hash.slice(0, 12)}: ${runs.length} runs, blocked ${JSON.stringify(runs[0]?.blockedOrigins)}`;
    });
    const perLateRequest = LATE_DELAYS_MILLISECONDS.map((delay) => {
        const shown = measures.filter((measure) => showsName(measure, lateName(delay))).length;
        return `+${delay} ms in ${shown}`;
    });
    return [
        `${measures.length} runs, ${hashes.length} distinct result hashes`,
        ...perHash,
        `late requests shown: ${perLateRequest.join(", ")}`,
    ].join("\n");
}

describe("Using the result hash of a run on the host", () => {
    for (const targetId of Object.values(BrowserTarget)) {
        describe(`given a run on ${targetId}`, onTarget(targetId), () => {
            describe("and a page that asks undeclared origins, some of them as the run ends", () => {
                describe(`when one plan runs ${RUNS} times`, () => {
                    let measures: readonly RunMeasure[];
                    before(async () => {
                        pageServed = ASKING_PAGE;
                        measures = await repeatRuns(targetId, RUNS);
                    });

                    test("then it should give every run the same result hash", (context) => {
                        const summary = summaryOf(measures);
                        context.diagnostic(summary);
                        assert.equal(
                            new Set(measures.map((measure) => measure.resultHash)).size,
                            1,
                            summary,
                        );
                    });

                    test("then it should give every run the evidence hash of what that run refused", () => {
                        for (const { result } of measures) {
                            assert.equal(evidenceHashOf(result), expectedEvidenceHash(result));
                        }
                    });

                    for (const name of EARLY_NAMES) {
                        test(`then it should show ${name} in every run, so there are refusals to repeat`, () => {
                            const without = measures.filter((measure) => !showsName(measure, name));
                            assert.equal(without.length, 0, summaryOf(measures));
                        });
                    }

                    test("then it should show a late request in some run, so the timing reached the run's end", () => {
                        const hasLateRequest = measures.some((measure) =>
                            LATE_DELAYS_MILLISECONDS.some((delay) =>
                                showsName(measure, lateName(delay)),
                            ),
                        );
                        assert.ok(hasLateRequest, summaryOf(measures));
                    });

                    describe("and the same plan runs on a page that asks for nothing undeclared", () => {
                        let quiet: readonly RunMeasure[];
                        before(async () => {
                            pageServed = QUIET_PAGE;
                            quiet = await repeatRuns(targetId, CONTROL_RUNS);
                            pageServed = ASKING_PAGE;
                        });

                        test("then it should give those runs the same result hash, since only the list differs", () => {
                            const hashes = new Set(
                                [...measures, ...quiet].map((measure) => measure.resultHash),
                            );
                            assert.equal(hashes.size, 1, summaryOf([...measures, ...quiet]));
                        });

                        test("then it should give those runs an evidence hash of their own, so the list is still covered", () => {
                            const hashes = new Set(
                                quiet.map((measure) => evidenceHashOf(measure.result)),
                            );
                            assert.equal(hashes.size, 1, summaryOf(quiet));
                            for (const measure of measures) {
                                assert.equal(hashes.has(evidenceHashOf(measure.result)), false);
                            }
                        });
                    });

                    describe("and a plan with one more check runs on the same page", () => {
                        let longer: readonly RunMeasure[];
                        before(async () => {
                            pageServed = ASKING_PAGE;
                            longer = await repeatRuns(
                                targetId,
                                CONTROL_RUNS,
                                STEPS_WITH_ONE_MORE_CHECK,
                            );
                        });

                        test("then it should give those runs another result hash, so the same hash means something", () => {
                            const hashes = new Set(longer.map((measure) => measure.resultHash));
                            assert.equal(hashes.size, 1, summaryOf(longer));
                            for (const measure of measures) {
                                assert.equal(hashes.has(measure.resultHash), false);
                            }
                        });
                    });
                });
            });
        });
    }
});
