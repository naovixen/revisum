// The run observes only the requests a plan names, from before its first step, so what a page sends
// as it loads counts and a plan naming none leaves the page's service workers alone. Every step that
// names a request must count, wherever it sits in the plan.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { planParser } from "@revisum/engine";
import { observedRequestNames } from "../../../packages/engine/src/network-and-storage/network-and-storage-steps.ts";
import {
    OBSERVED_REQUESTS,
    expectRequests,
    expectResponse,
    rememberResponse,
    resetRequests,
} from "./stub-and-storage-examples.ts";
import { parsedProject } from "./unsafe-feature-examples.ts";
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

const parsePlan = planParser(
    parsedProject(unsafeProjectFile(FEATURES, { observedRequests: OBSERVED_REQUESTS })),
);

const namesIn = (steps: readonly JsonRecord[]): readonly string[] => {
    const parsed = parsePlan(unsafePlan([OPEN_CART, ...steps]));
    assert.ok(parsed.ok, `the plan was rejected: ${JSON.stringify(parsed)}`);
    return observedRequestNames(parsed.value);
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

describe("Using the requests a plan names", () => {
    for (const { name, step } of STEPS_NAMING_A_REQUEST) {
        describe(`given ${name}`, () => {
            describe("when the requests to observe are listed", () => {
                test("then it should list the request", () => {
                    assert.deepEqual(namesIn([step]), [LIKES]);
                });
            });
        });

        for (const { name: containerName, around } of CONTAINERS) {
            describe(`given ${name} inside ${containerName}`, () => {
                describe("when the requests to observe are listed", () => {
                    test("then it should list the request", () => {
                        assert.deepEqual(namesIn([around([step])]), [LIKES]);
                    });
                });
            });
        }
    }

    describe("given a plan naming no request", () => {
        describe("when the requests to observe are listed", () => {
            test("then it should list none", () => {
                assert.deepEqual(namesIn([]), []);
            });
        });
    });

    describe("given a remember that reads the page, not a response", () => {
        describe("when the requests to observe are listed", () => {
            test("then it should list none", () => {
                assert.deepEqual(namesIn([REMEMBER_ATTRIBUTE]), []);
            });
        });
    });

    describe("given requests named more than once, across containers", () => {
        describe("when the requests to observe are listed", () => {
            test("then it should list each once, in the order the plan first names it", () => {
                const names = namesIn([
                    inFrame([resetRequests(SCHEDULE_LOADS)]),
                    resetRequests(LIKES),
                    resetRequests(SCHEDULE_LOADS),
                    inNewTab([resetRequests(LIKES)]),
                ]);
                assert.deepEqual(names, [SCHEDULE_LOADS, LIKES]);
            });
        });
    });

    describe("given a request named only in a frame inside a new tab", () => {
        describe("when the requests to observe are listed", () => {
            test("then it should list the request", () => {
                assert.deepEqual(namesIn([inNewTab([inFrame([resetRequests(LIKES)])])]), [LIKES]);
            });
        });
    });
});
