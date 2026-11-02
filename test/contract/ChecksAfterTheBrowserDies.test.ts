// A real browser dies between two steps, and the last step only reads what the driver has recorded
// about requests. Nothing about that step touches the page, so nothing but an explicit look can
// notice: a pass here would be a verdict on a page nobody can see any more.
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import type { DriverSession } from "@revisum/driver-cdp";
import type { ActionGuard, ActionStep, Secret, SessionEnvironment, Target } from "@revisum/engine";
import { outcomes, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { DriverAdapter } from "#test-support/browser/BrowserTarget.ts";
import { driverForTarget } from "#test-support/browser/CreateBrowserDriver.ts";
import {
    click,
    navigate,
    role,
    testId,
    textEquals,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { driverWith, sessionWith } from "#test-support/browser/WrappingSessions.ts";
import { endAtOnce, rendererProcesses } from "#test-support/process-tree.ts";
import { expectRequests, expectResponse, rememberResponse } from "./network-stubs-support.ts";
import {
    TARGET,
    htmlPage,
    jsonRoute,
    requestMatcher,
    routedPagesHarness,
} from "./RoutedPagesHarness.ts";

const CRASH_NOTICE_MILLISECONDS = 5000;
const CRASH_NOTICE_POLL_MILLISECONDS = 20;

const ITEMS_PAGE = htmlPage(`
  <button type="button" id="load">Load items</button>
  <p data-testid="state">Not loaded</p>
  <script>
    document.getElementById('load').addEventListener('click', async () => {
      await (await fetch('/api/items')).json();
      document.querySelector('[data-testid="state"]').textContent = 'Loaded';
    });
  </script>`);

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        routes: new Map([
            ["/items.html", ITEMS_PAGE],
            ["/api/items", jsonRoute({ firstName: "Kettle" })],
        ]),
        observedRequests: (origin) => ({
            items: {
                request: requestMatcher(origin, "/api/items"),
                fields: { firstName: "/firstName" },
            },
            neverSent: { request: requestMatcher(origin, "/api/never") },
        }),
    });
});
after(async () => {
    await harness.close();
});

type Death = "renderer" | "browser";

// A driver that ends the renderers or the browser as a hover step finishes, and waits until the
// session has seen it, so the next step starts on a page already known to be dead.
function driverThatDiesAfterTheHover(death: Death | null) {
    const inner = driverForTarget(TARGET);
    const seen = { sawDeath: false };
    const dieIn = async (session: DriverSession, kind: Death): Promise<void> => {
        const victims =
            kind === "browser"
                ? [session.processId]
                : rendererProcesses(session.processId).map((process) => process.processId);
        for (const processId of victims) {
            endAtOnce(processId);
        }
        const deadline = Date.now() + CRASH_NOTICE_MILLISECONDS;
        while (session.crashed?.() !== true && Date.now() < deadline) {
            await pause(CRASH_NOTICE_POLL_MILLISECONDS);
        }
        seen.sawDeath = session.crashed?.() === true;
    };
    const driver = driverWith(inner, {
        open: async (target: Target, environment: SessionEnvironment) => {
            const opened = await inner.open(target, environment);
            if (!opened.ok) {
                return opened;
            }
            const session = opened.value;
            const act = async (step: ActionStep, guard: ActionGuard, secret?: Secret) => {
                const acted = await session.act(step, guard, secret);
                if (step.type === "hover" && death !== null) {
                    await dieIn(session, death);
                }
                return acted;
            };
            return { ok: true as const, value: sessionWith(session, { act }) };
        },
    });
    return { drivers: new Map([[DriverAdapter.Cdp, driver]]), seen };
}

const LOAD_BUTTON = role("button", "Load items");
const STEPS_BEFORE: readonly JsonRecord[] = [
    navigate("/items.html"),
    click(LOAD_BUTTON),
    textEquals(testId("state"), "Loaded", "items.loaded"),
    { type: "hover", locator: LOAD_BUTTON },
];
const CHECK_INDEX = STEPS_BEFORE.length;

// A remember is no check, and a plan must hold one, so a check follows it; the remember's own result
// is what the test reads.
const CLOSING_CHECK = textEquals(testId("state"), "Loaded", "items.still-loaded");

const FINAL_STEPS: readonly { readonly name: string; readonly steps: readonly JsonRecord[] }[] = [
    {
        name: "expectRequests equals 0",
        steps: [expectRequests("neverSent", { equals: 0 }, "items.none-sent")],
    },
    {
        name: "expectRequests atMost 1",
        steps: [expectRequests("items", { atMost: 1 }, "items.at-most-one")],
    },
    {
        name: "expectRequests atLeast 1",
        steps: [expectRequests("items", { atLeast: 1 }, "items.at-least-one")],
    },
    {
        name: "expectResponse statusEquals 200",
        steps: [expectResponse("items", { kind: "statusEquals", value: 200 }, "items.answered")],
    },
    {
        name: "a remember from the response",
        steps: [rememberResponse("firstName", "items", "firstName", "text"), CLOSING_CHECK],
    },
];

describe("Using a run in a real browser", () => {
    for (const { name, steps } of FINAL_STEPS) {
        for (const death of ["renderer", "browser"] as const) {
            describe(`given a plan whose next step is ${name}`, () => {
                describe(`and the ${death} dies just before that step`, () => {
                    describe("when the run ends", () => {
                        test("then it should fail the step with target-crashed", async () => {
                            const { drivers, seen } = driverThatDiesAfterTheHover(death);
                            const { result } = await harness.runSteps(
                                TARGET,
                                [...STEPS_BEFORE, ...steps],
                                { drivers },
                            );
                            assert.ok(seen.sawDeath, "the session saw the death");
                            assert.equal(result.state, "Failed", JSON.stringify(result.steps));
                            assert.deepEqual(
                                outcomes(result)[CHECK_INDEX],
                                [CHECK_INDEX, "failed", "target-crashed"],
                                JSON.stringify(result.steps),
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
                        const { drivers } = driverThatDiesAfterTheHover(null);
                        const { result } = await harness.runSteps(
                            TARGET,
                            [...STEPS_BEFORE, ...steps],
                            { drivers },
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        });
    }
});
