// A refused connection is a request the page sent that got no response. A check must hold on both
// counts: "at least one" needs a response, because the page never reached the API, and "none" or
// "at most" count the attempt, because the page still tried to send it.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
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
import { expectRequests } from "./network-stubs-support.ts";
import {
    TARGET,
    closedOrigin,
    htmlPage,
    jsonRoute,
    requestMatcher,
    routedPagesHarness,
} from "./RoutedPagesHarness.ts";

shareBrowserInThisFile();

const ASK_REFUSED = "Ask the refusing server";
const ASK_BROKEN = "Ask the broken server";

let harness: BrowserHarness;

before(async () => {
    const refusedOrigin = await closedOrigin();
    harness = await routedPagesHarness({
        otherOrigins: [refusedOrigin],
        routes: new Map([
            [
                "/ask.html",
                htmlPage(`
                  <button type="button" data-url="${refusedOrigin}/api/refused">${ASK_REFUSED}</button>
                  <button type="button" data-url="/api/broken">${ASK_BROKEN}</button>
                  <p data-testid="state">Not asked</p>
                  <script>
                    for (const button of document.querySelectorAll('button')) {
                      button.addEventListener('click', () => {
                        const finish = (text) => { document.querySelector('[data-testid="state"]').textContent = text; };
                        fetch(button.dataset.url).then(() => finish('Answered'), () => finish('Refused'));
                      });
                    }
                  </script>`),
            ],
            ["/api/broken", jsonRoute({ error: "database down" }, 500)],
        ]),
        observedRequests: (origin) => ({
            refused: { request: requestMatcher(refusedOrigin, "/api/refused") },
            broken: { request: requestMatcher(origin, "/api/broken") },
        }),
    });
});
after(async () => {
    await harness.close();
});

const refusedRequest = (count: JsonRecord): readonly JsonRecord[] => [
    navigate("/ask.html"),
    click(role("button", ASK_REFUSED)),
    textEquals(testId("state"), "Refused", "ask.refused"),
    expectRequests("refused", count, "ask.counted"),
];
const answeredRequest = (count: JsonRecord): readonly JsonRecord[] => [
    navigate("/ask.html"),
    click(role("button", ASK_BROKEN)),
    textEquals(testId("state"), "Answered", "ask.answered"),
    expectRequests("broken", count, "ask.counted"),
];

describe("Using a run in a real browser", () => {
    for (const count of [{ atLeast: 1 }, { equals: 1 }]) {
        describe("given a request whose connection the server refused", () => {
            describe(`when an expectRequests ${JSON.stringify(count)} check runs`, () => {
                test("then it should fail, since no response arrived", async () => {
                    const { result } = await harness.runSteps(TARGET, refusedRequest(count));
                    assert.deepEqual(
                        outcomes(result)[3],
                        [3, "failed", "assertion-failed"],
                        JSON.stringify(result.steps),
                    );
                });
            });
        });
    }

    for (const count of [{ equals: 0 }, { atMost: 0 }]) {
        describe("given a request whose connection the server refused", () => {
            describe(`when an expectRequests ${JSON.stringify(count)} check runs`, () => {
                test("then it should fail, since the page still sent the request", async () => {
                    const { result } = await harness.runSteps(TARGET, refusedRequest(count));
                    assert.deepEqual(
                        outcomes(result)[3],
                        [3, "failed", "assertion-failed"],
                        JSON.stringify(result.steps),
                    );
                });
            });
        });
    }

    for (const count of [{ atLeast: 1 }, { equals: 1 }]) {
        describe("given a request the server answered with a 500", () => {
            describe(`when an expectRequests ${JSON.stringify(count)} check runs`, () => {
                test("then it should pass, since a response arrived", async () => {
                    const { result } = await harness.runSteps(TARGET, answeredRequest(count));
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });
    }
});
