// "The latest response" means the latest the page has asked for, so an earlier answer must not pass
// a check while a newer request to the same URL is still on its way. The server here sends nothing
// for the newer request until its hold is over, so that request really is in flight.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { sha256 } from "@revisum/engine";
import { outcomes, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import {
    click,
    navigate,
    role,
    testId,
    textEquals,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { expectResponse, rememberResponse } from "./network-stubs-support.ts";
import {
    TARGET,
    htmlPage,
    requestMatcher,
    routedPagesHarness,
    startHeldAnswerServer,
    type HeldAnswerServer,
} from "./RoutedPagesHarness.ts";

shareBrowserInThisFile();

// Long enough that a first look cannot see the answer, and well inside the step timeout.
const HOLD_MILLISECONDS = 1500;

const SCENARIOS = {
    earlierOkNewerFails: "Earlier ok, newer fails",
    earlierOkNewerOk: "Earlier ok, newer ok",
    earlierFailsNewerOk: "Earlier fails, newer ok",
    onlyOne: "Only one",
    onlySlowOne: "Only a slow one",
} as const;

const answerUrl = (origin: string, status: number, id: string, holdMilliseconds = 0): string =>
    `${origin}/api/answer?status=${status}&id=${id}&holdMilliseconds=${holdMilliseconds}`;

// One button: it asks `earlier`, says so on the page, then asks `newer` if there is one.
const scenarioButton = (name: string, earlier: string, newer?: string): string => `
  <button type="button" data-earlier="${earlier}" data-newer="${newer ?? ""}">${name}</button>`;

const pageFor = (origin: string): string => `
  ${scenarioButton(SCENARIOS.earlierOkNewerFails, answerUrl(origin, 200, "first"), answerUrl(origin, 500, "second", HOLD_MILLISECONDS))}
  ${scenarioButton(SCENARIOS.earlierOkNewerOk, answerUrl(origin, 200, "first"), answerUrl(origin, 200, "second", HOLD_MILLISECONDS))}
  ${scenarioButton(SCENARIOS.earlierFailsNewerOk, answerUrl(origin, 500, "first"), answerUrl(origin, 200, "second", HOLD_MILLISECONDS))}
  ${scenarioButton(SCENARIOS.onlyOne, answerUrl(origin, 200, "first"))}
  ${scenarioButton(SCENARIOS.onlySlowOne, answerUrl(origin, 200, "first", HOLD_MILLISECONDS))}
  <p data-testid="state">Waiting</p>
  <script>
    for (const button of document.querySelectorAll('button')) {
      button.addEventListener('click', async () => {
        await fetch(button.dataset.earlier);
        if (button.dataset.newer !== '') fetch(button.dataset.newer);
        document.querySelector('[data-testid="state"]').textContent = 'Earlier answered';
      });
    }
  </script>`;

let answers: HeldAnswerServer;
let harness: BrowserHarness;

before(async () => {
    answers = await startHeldAnswerServer();
    harness = await routedPagesHarness({
        otherOrigins: [answers.origin],
        routes: new Map([["/answers.html", htmlPage(pageFor(answers.origin))]]),
        observedRequests: () => ({
            answer: {
                request: requestMatcher(answers.origin, "/api/answer"),
                fields: { id: "/id" },
            },
        }),
    });
});
after(async () => {
    await harness.close();
    await answers.close();
});

const stepsUpToTheEarlierAnswer = (scenario: string): readonly JsonRecord[] => [
    navigate("/answers.html"),
    click(role("button", scenario)),
    textEquals(testId("state"), "Earlier answered", "answers.earlier-answered"),
];
const statusIs = (status: number): JsonRecord =>
    expectResponse("answer", { kind: "statusEquals", value: status }, "answers.latest-status");
const REMEMBER_ID = rememberResponse("latestId", "answer", "id", "text");
const CLOSING_CHECK = textEquals(testId("state"), "Earlier answered", "answers.still-shown");

describe("Using a run in a real browser", () => {
    describe("given an earlier request answered 200", () => {
        describe("and a newer request to the same URL in flight that will be answered 500", () => {
            describe("when a statusEquals 200 check runs", () => {
                test("then it should see the newer answer and fail", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        ...stepsUpToTheEarlierAnswer(SCENARIOS.earlierOkNewerFails),
                        statusIs(200),
                    ]);
                    assert.deepEqual(
                        outcomes(result)[3],
                        [3, "failed", "assertion-failed"],
                        JSON.stringify(result.steps),
                    );
                });
            });

            describe("when a statusEquals 500 check runs", () => {
                test("then it should see the newer answer and pass", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        ...stepsUpToTheEarlierAnswer(SCENARIOS.earlierOkNewerFails),
                        statusIs(500),
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });

        describe("and a newer request to the same URL in flight that will be answered 200", () => {
            describe("when a remember reads a field of the response", () => {
                test("then it should remember the newer answer's field", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        ...stepsUpToTheEarlierAnswer(SCENARIOS.earlierOkNewerOk),
                        REMEMBER_ID,
                        CLOSING_CHECK,
                    ]);
                    assert.equal(
                        result.steps[3]?.remembered?.sha256,
                        sha256("second"),
                        JSON.stringify(result.steps),
                    );
                });
            });
        });

        describe("and no newer request", () => {
            describe("when a statusEquals 200 check runs", () => {
                test("then it should pass", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        ...stepsUpToTheEarlierAnswer(SCENARIOS.onlyOne),
                        statusIs(200),
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });

            describe("when a remember reads a field of the response", () => {
                test("then it should remember that answer's field", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        ...stepsUpToTheEarlierAnswer(SCENARIOS.onlyOne),
                        REMEMBER_ID,
                        CLOSING_CHECK,
                    ]);
                    assert.equal(
                        result.steps[3]?.remembered?.sha256,
                        sha256("first"),
                        JSON.stringify(result.steps),
                    );
                });
            });
        });
    });

    describe("given an earlier request answered 500", () => {
        describe("and a newer request to the same URL in flight that will be answered 200", () => {
            describe("when a statusEquals 200 check runs", () => {
                test("then it should wait for the newer answer and pass", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        ...stepsUpToTheEarlierAnswer(SCENARIOS.earlierFailsNewerOk),
                        statusIs(200),
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });
    });

    describe("given one request in flight with no answer yet", () => {
        describe("when a statusEquals 200 check runs", () => {
            test("then it should wait for the answer and pass", async () => {
                const { result } = await harness.runSteps(TARGET, [
                    navigate("/answers.html"),
                    click(role("button", SCENARIOS.onlySlowOne)),
                    statusIs(200),
                ]);
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });
});
