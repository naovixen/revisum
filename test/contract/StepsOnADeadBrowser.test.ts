// A step that needs the page says target-crashed when the renderer or the browser has died, and says
// so at once: nothing on a dead page can change, so there is nothing to wait for. Each of these
// steps ends on a dead browser in its own way, and a step timeout of 8 seconds shows up any wait.
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import type { DriverSession } from "@revisum/driver-cdp";
import type {
    ActionGuard,
    ActionStep,
    DownloadStep,
    Secret,
    SessionEnvironment,
    Target,
} from "@revisum/engine";
import {
    outcomes,
    stepMilliseconds,
    type BrowserHarness,
} from "#test-support/browser/BrowserHarness.ts";
import { DriverAdapter } from "#test-support/browser/BrowserTarget.ts";
import { driverForTarget } from "#test-support/browser/CreateBrowserDriver.ts";
import {
    capture,
    navigate,
    role,
    testId,
    textEquals,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { driverWith, sessionWith } from "#test-support/browser/WrappingSessions.ts";
import { endAtOnce, rendererProcesses } from "#test-support/process-tree.ts";
import { download, expectDownload } from "./page-states-support.ts";
import { TARGET, htmlPage, routedPagesHarness } from "./RoutedPagesHarness.ts";

const STEP_TIMEOUT_MILLISECONDS = 8000;
const AT_ONCE_MILLISECONDS = 4000;
const CRASH_NOTICE_MILLISECONDS = 5000;
const CRASH_NOTICE_POLL_MILLISECONDS = 20;

const WAITING_SIGNAL_PATH = "/waiting-signal.txt";
const SLOW_FILE_PATH = "/slow-file.csv";
const QUICK_FILE_PATH = "/quick-file.csv";
// Longer than the step's timeout, so the file is still arriving when the browser dies.
const SLOW_FILE_PAUSE_MILLISECONDS = 20_000;
// Long enough for the click to have ended, and for the browser to have the slow file's first bytes
// and begin the download, so the step is in its wait for the file.
const STEP_IN_ITS_WAIT_MILLISECONDS = 500;
const FILE_NAME = "report";

const attachment = (path: string) => ({
    "content-type": "text/csv",
    "content-disposition": `attachment; filename="${path.slice(1)}"`,
});

const PAGE = `
  <button type="button" id="waits">Start and wait</button>
  <a href="${SLOW_FILE_PATH}">Slow file</a>
  <a href="${QUICK_FILE_PATH}">Quick file</a>
  <p data-testid="state">Ready</p>
  <script>
    document.getElementById('waits').addEventListener('click', () => {
      fetch('${WAITING_SIGNAL_PATH}').catch(() => undefined);
    });
  </script>`;

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        routes: new Map([
            ["/page.html", htmlPage(PAGE)],
            [WAITING_SIGNAL_PATH, () => ({ headers: { "content-type": "text/plain" }, body: "" })],
            [
                SLOW_FILE_PATH,
                () => ({
                    headers: attachment(SLOW_FILE_PATH),
                    chunks: [Buffer.from("name\n"), Buffer.from("Slow report\n")],
                    chunkPauseMilliseconds: SLOW_FILE_PAUSE_MILLISECONDS,
                }),
            ],
            [
                QUICK_FILE_PATH,
                () => ({ headers: attachment(QUICK_FILE_PATH), body: "name\nQuick report\n" }),
            ],
        ]),
    });
});
after(async () => {
    await harness.close();
});

type Death = "renderer" | "browser";

const endTheProcesses = (session: DriverSession, death: Death): void => {
    const victims =
        death === "browser"
            ? [session.processId]
            : rendererProcesses(session.processId).map((process) => process.processId);
    for (const processId of victims) {
        endAtOnce(processId);
    }
};

const untilTheSessionSeesTheDeath = async (session: DriverSession): Promise<boolean> => {
    const deadline = Date.now() + CRASH_NOTICE_MILLISECONDS;
    while (!session.crashed() && Date.now() < deadline) {
        await pause(CRASH_NOTICE_POLL_MILLISECONDS);
    }
    return session.crashed();
};

// What a test replaces on the session, given the session and a way to kill it that waits until the
// session has seen the death.
type DyingMembers = (dying: {
    readonly session: DriverSession;
    readonly die: () => Promise<void>;
}) => Readonly<Record<string, unknown>>;

function driversThatDie(death: Death | null, members: DyingMembers) {
    const inner = driverForTarget(TARGET);
    const seen = { sawDeath: false };
    const driver = driverWith(inner, {
        open: async (target: Target, environment: SessionEnvironment) => {
            const opened = await inner.open(target, environment);
            if (!opened.ok) {
                return opened;
            }
            const session = opened.value;
            const die = async (): Promise<void> => {
                if (death !== null) {
                    endTheProcesses(session, death);
                    seen.sawDeath = await untilTheSessionSeesTheDeath(session);
                }
            };
            return { ok: true as const, value: sessionWith(session, members({ session, die })) };
        },
    });
    return { drivers: new Map([[DriverAdapter.Cdp, driver]]), seen };
}

// The death comes as a hover finishes, so the next step starts on a page already known to be dead.
const dyingAfterTheHover: DyingMembers = ({ session, die }) => ({
    act: async (step: ActionStep, guard: ActionGuard, secret?: Secret) => {
        const acted = await session.act(step, guard, secret);
        if (step.type === "hover") {
            await die();
        }
        return acted;
    },
});

// The death comes after the run has seen a live page and started the step, before the step's first
// command to the page.
const dyingAsTheStepBegins: DyingMembers = ({ session, die }) => ({
    audit: async () => {
        await die();
        return session.audit();
    },
    screenshot: async (mask: readonly string[]) => {
        await die();
        return session.screenshot(mask);
    },
    download: async (step: DownloadStep, maximumBytes: number, guard: ActionGuard) => {
        await die();
        return session.download(step, maximumBytes, guard);
    },
});

const HOVER: JsonRecord = { type: "hover", locator: role("button", "Start and wait") };
const STATE_SHOWN = textEquals(testId("state"), "Ready", "state.shown");
const STEPS_BEFORE: readonly JsonRecord[] = [navigate("/page.html"), STATE_SHOWN, HOVER];
const FIRST_STEP_AFTER = STEPS_BEFORE.length;

const THE_STEPS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: "an a11yAudit", step: { type: "a11yAudit", mode: "report" } },
    { name: "a capture", step: capture("after-death") },
    { name: "a download step", step: download(FILE_NAME, role("link", "Quick file")) },
];

const DEATHS: readonly Death[] = ["renderer", "browser"];

const assertFailedAtOnceWithTargetCrashed = async (
    death: Death,
    steps: readonly JsonRecord[],
    index: number,
    members: DyingMembers,
): Promise<void> => {
    const { drivers, seen } = driversThatDie(death, members);
    const { result } = await harness.runSteps(TARGET, steps, { drivers });
    assert.ok(seen.sawDeath, "the session saw the death");
    assert.deepEqual(
        outcomes(result)[index],
        [index, "failed", "target-crashed"],
        JSON.stringify(result.steps),
    );
    assert.equal(result.state, "Failed", JSON.stringify(result.steps));
    const took = stepMilliseconds(result, index);
    assert.ok(took < AT_ONCE_MILLISECONDS, `took ${took} ms`);
};

// The death comes a moment after a page has asked the server for the path.
const dyingSoonAfterTheRequest =
    (path: string): DyingMembers =>
    ({ die }) => {
        void harness.requested(path).then(async () => {
            await pause(STEP_IN_ITS_WAIT_MILLISECONDS);
            await die();
        });
        return {};
    };

describe("Using a run in a real browser", () => {
    for (const { name, step } of THE_STEPS) {
        for (const death of DEATHS) {
            describe(`given a plan whose next step is ${name}`, () => {
                describe(`and the ${death} dies just before that step`, () => {
                    describe("when the run ends", () => {
                        test("then it should fail the step with target-crashed, at once", async () => {
                            await assertFailedAtOnceWithTargetCrashed(
                                death,
                                [...STEPS_BEFORE, step, STATE_SHOWN],
                                FIRST_STEP_AFTER,
                                dyingAfterTheHover,
                            );
                        });
                    });
                });

                describe(`and the ${death} dies as that step begins`, () => {
                    describe("when the run ends", () => {
                        test("then it should fail the step with target-crashed, at once", async () => {
                            await assertFailedAtOnceWithTargetCrashed(
                                death,
                                [...STEPS_BEFORE, step, STATE_SHOWN],
                                FIRST_STEP_AFTER,
                                dyingAsTheStepBegins,
                            );
                        });
                    });
                });
            });
        }

        describe(`given a plan whose next step is ${name}`, () => {
            describe("and the browser stays alive", () => {
                describe("when the run ends", () => {
                    test("then it should pass", async () => {
                        const { drivers } = driversThatDie(null, dyingAsTheStepBegins);
                        const { result } = await harness.runSteps(
                            TARGET,
                            [...STEPS_BEFORE, step, STATE_SHOWN],
                            { drivers },
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        });
    }

    for (const death of DEATHS) {
        describe("given a download step waiting for its click to start a file", () => {
            describe(`and the ${death} dies during that wait`, () => {
                describe("when the run ends", () => {
                    test("then it should fail the step with target-crashed, at once", async () => {
                        await assertFailedAtOnceWithTargetCrashed(
                            death,
                            [
                                navigate("/page.html"),
                                download(FILE_NAME, role("button", "Start and wait")),
                                STATE_SHOWN,
                            ],
                            1,
                            dyingSoonAfterTheRequest(WAITING_SIGNAL_PATH),
                        );
                    });
                });
            });
        });

        describe("given a download step whose file is still arriving", () => {
            describe(`and the ${death} dies before the file has arrived`, () => {
                describe("when the run ends", () => {
                    test("then it should fail the step with target-crashed, at once", async () => {
                        await assertFailedAtOnceWithTargetCrashed(
                            death,
                            [
                                navigate("/page.html"),
                                download(FILE_NAME, role("link", "Slow file")),
                                STATE_SHOWN,
                            ],
                            1,
                            dyingSoonAfterTheRequest(SLOW_FILE_PATH),
                        );
                    });
                });
            });
        });
    }

    describe("given a download step whose click starts a file", () => {
        describe("and the browser stays alive", () => {
            describe("when the run ends", () => {
                test("then it should keep the file", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        navigate("/page.html"),
                        download(FILE_NAME, role("link", "Quick file")),
                        expectDownload(
                            FILE_NAME,
                            { kind: "contentContains", value: "Quick report" },
                            "file.holds-the-report",
                        ),
                        visible(testId("state"), "state.visible"),
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });
    });
});
