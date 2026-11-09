// The own CDP driver performs every step of declared stubs, request checks and web storage, and a
// plan without any of them runs too.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import {
    click,
    navigate,
    role,
    testId,
    textEquals,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import {
    expectRequests,
    expectResponse,
    expectStorage,
    networkHarness,
    rememberResponse,
    removeStorage,
    resetRequests,
    setStorage,
    startStub,
    type NetworkHarness,
} from "./support/NetworkRun.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";

shareBrowserInThisFile();

let harness: NetworkHarness;
before(async () => {
    harness = await networkHarness();
});
after(async () => {
    await harness.close();
});

// Each step on the requests page, where the schedule loads once.
const NETWORK_AND_STORAGE_STEPS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: "a stub start", step: startStub("answerSequence") },
    { name: "a resetRequests", step: resetRequests("scheduleLoads") },
    {
        name: "an expectRequests",
        step: expectRequests("scheduleLoads", { equals: 1 }, "support.schedule-count"),
    },
    {
        name: "an expectResponse",
        step: expectResponse(
            "scheduleLoads",
            { kind: "statusEquals", value: 200 },
            "support.schedule-status",
        ),
    },
    {
        name: "a remember from a response",
        step: rememberResponse("scheduleDay", "scheduleLoads", "day", "text"),
    },
    { name: "a setStorage", step: setStorage("menuDocked", { docked: true }) },
    { name: "a removeStorage", step: removeStorage("menuDocked") },
    {
        name: "an expectStorage",
        step: expectStorage("menuDocked", { kind: "absent" }, "support.menu-absent"),
    },
];

const continued = (): JsonRecord =>
    textEquals(testId("continue-state"), "Continued", "support.continued");
// Open the page, wait for its schedule, use the step, then send input and check the page.
const stepsWith = (step: JsonRecord): unknown[] => [
    navigate("/requests.html"),
    textEquals(testId("schedule-state"), "Schedule loaded", "support.schedule-loaded"),
    step,
    click(role("button", "Continue")),
    continued(),
];

describe(`the own CDP driver: ${BrowserTarget.Chrome}`, () => {
    test("counter-example: a run without any of those steps passes and sends its input", async () => {
        const ran = await harness.runSteps(BrowserTarget.Chrome, [
            navigate("/requests.html"),
            textEquals(testId("schedule-state"), "Schedule loaded", "support.schedule-loaded"),
            click(role("button", "Continue")),
            continued(),
        ]);
        assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
    });

    for (const { name, step } of NETWORK_AND_STORAGE_STEPS) {
        test(`a run with ${name} performs it and passes`, async () => {
            const ran = await harness.runSteps(BrowserTarget.Chrome, stepsWith(step));
            assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
        });
    }
});
