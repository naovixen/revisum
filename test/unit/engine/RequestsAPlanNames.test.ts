// The run observes only the requests a plan names, from before its first step, so what a page sends
// as it loads counts and a plan naming none leaves the page's service workers alone. Every step that
// names a request must count, wherever it sits in the plan.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { success } from "@revisum/engine";
import { fakeNetwork, fakeSession, runOnFakeSession } from "./RunOnFakeSession.ts";
import {
    OBSERVED_REQUESTS,
    expectRequests,
    expectResponse,
    rememberResponse,
    resetRequests,
} from "./stub-and-storage-examples.ts";
import {
    FEATURES,
    OPEN_CART,
    REMEMBER_ATTRIBUTE,
    unsafePlan,
    unsafeProjectFile,
    type JsonRecord,
} from "./unsafe-feature-steps.ts";

const LIKES = "likes";
const SCHEDULE_LOADS = "scheduleLoads";

const PROJECT_FILE = unsafeProjectFile(FEATURES, { observedRequests: OBSERVED_REQUESTS });

// Runs the steps after opening a page, and gives what was observed before that first step began and
// over the whole run. A step that resets a request observes it again, so only the first says what
// the run started from.
const observedInARunOf = async (
    steps: readonly JsonRecord[],
): Promise<{
    readonly beforeTheFirstStep: readonly string[];
    readonly overTheRun: readonly string[];
}> => {
    const beforeTheFirstStep: string[] = [];
    const overTheRun: string[] = [];
    let hasFirstStepBegun = false;
    const session = fakeSession({
        navigate: () => {
            hasFirstStepBegun = true;
            return Promise.resolve(success(undefined));
        },
        network: {
            ...fakeNetwork(),
            observe: (name) => {
                overTheRun.push(name);
                if (!hasFirstStepBegun) {
                    beforeTheFirstStep.push(name);
                }
                return Promise.resolve(success(undefined));
            },
        },
    });
    await runOnFakeSession(unsafePlan([OPEN_CART, ...steps]), {
        session,
        projectFile: PROJECT_FILE,
    });
    assert.ok(hasFirstStepBegun, "the run should reach its first step");
    return { beforeTheFirstStep, overTheRun };
};

const inFrame = (steps: readonly JsonRecord[]): JsonRecord => ({
    type: "frame",
    locator: { by: "testId", testId: "checkout-frame" },
    steps,
});
const inNewTab = (steps: readonly JsonRecord[]): JsonRecord => ({
    type: "newTab",
    url: "/orders",
    steps,
});

const STEPS_NAMING_A_REQUEST: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: "a resetRequests", step: resetRequests(LIKES) },
    { name: "an expectRequests", step: expectRequests(LIKES, { equals: 0 }) },
    {
        name: "an expectResponse",
        step: expectResponse(LIKES, { kind: "statusEquals", value: 200 }),
    },
    {
        name: "a remember from a response",
        step: rememberResponse("likeCount", LIKES, "likeList", "arrayLength"),
    },
];

const CONTAINERS: readonly {
    readonly name: string;
    readonly around: (steps: readonly JsonRecord[]) => JsonRecord;
}[] = [
    { name: "a frame", around: inFrame },
    { name: "a new tab", around: inNewTab },
];

describe("Using a run of a plan that names requests", () => {
    for (const { name, step } of STEPS_NAMING_A_REQUEST) {
        describe(`given ${name}`, () => {
            describe("when the run starts", () => {
                test("then it should observe the request before the first step", async () => {
                    const { beforeTheFirstStep } = await observedInARunOf([step]);
                    assert.deepEqual(beforeTheFirstStep, [LIKES]);
                });
            });
        });

        for (const { name: containerName, around } of CONTAINERS) {
            describe(`given ${name} inside ${containerName}`, () => {
                describe("when the run starts", () => {
                    test("then it should observe the request before the first step", async () => {
                        const { beforeTheFirstStep } = await observedInARunOf([around([step])]);
                        assert.deepEqual(beforeTheFirstStep, [LIKES]);
                    });
                });
            });
        }
    }

    describe("given a plan naming no request", () => {
        describe("when the run ends", () => {
            test("then it should have observed none", async () => {
                const { overTheRun } = await observedInARunOf([]);
                assert.deepEqual(overTheRun, []);
            });
        });
    });

    describe("given a remember that reads the page, not a response", () => {
        describe("when the run ends", () => {
            test("then it should have observed none", async () => {
                const { overTheRun } = await observedInARunOf([REMEMBER_ATTRIBUTE]);
                assert.deepEqual(overTheRun, []);
            });
        });
    });

    describe("given requests named more than once, across containers", () => {
        describe("when the run starts", () => {
            test("then it should observe each once, in the order the plan first names it", async () => {
                const { beforeTheFirstStep } = await observedInARunOf([
                    inFrame([resetRequests(SCHEDULE_LOADS)]),
                    resetRequests(LIKES),
                    resetRequests(SCHEDULE_LOADS),
                    inNewTab([resetRequests(LIKES)]),
                ]);
                assert.deepEqual(beforeTheFirstStep, [SCHEDULE_LOADS, LIKES]);
            });
        });
    });

    describe("given a request named only in a frame inside a new tab", () => {
        describe("when the run starts", () => {
            test("then it should observe the request before the first step", async () => {
                const { beforeTheFirstStep } = await observedInARunOf([
                    inNewTab([inFrame([resetRequests(LIKES)])]),
                ]);
                assert.deepEqual(beforeTheFirstStep, [LIKES]);
            });
        });
    });
});
