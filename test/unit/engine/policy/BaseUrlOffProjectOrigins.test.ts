// A run's relative paths resolve against its base URL, and the browser may reach only the project's
// origins. A base URL on any other origin would fail every relative navigate part way through, after
// the browser opened, so the run is refused before any side effect, naming the base URL's origin.
// Origins are compared whole: one that only starts with a declared origin's text is another origin.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    OPEN_ORDERS,
    ORIGIN,
    planOf,
    runPlan,
    type Recording,
} from "../run/values/examples/RunPlan.ts";

const OFF_PROJECT_BASE_URLS: readonly { readonly baseUrl: string; readonly origin: string }[] = [
    { baseUrl: "https://elsewhere.example.org", origin: "https://elsewhere.example.org" },
    { baseUrl: "https://elsewhere.example.org/app/", origin: "https://elsewhere.example.org" },
    // The declared origin's text followed by one more digit: a different port.
    { baseUrl: `${ORIGIN}0`, origin: `${ORIGIN}0` },
    { baseUrl: `${ORIGIN.replace("http:", "https:")}/`, origin: ORIGIN.replace("http:", "https:") },
];

const ON_PROJECT_BASE_URLS: readonly string[] = [ORIGIN, `${ORIGIN}/`, `${ORIGIN}/app/`];

const assertNothingReached = (recording: Recording): void => {
    assert.deepEqual(recording.environments, [], "a browser session was opened");
    assert.deepEqual(recording.navigations, [], "a navigation reached the driver");
    assert.deepEqual(recording.actions, [], "an action reached the driver");
    assert.equal(recording.probes, 0, "a check reached the driver");
};

describe("Using the run", () => {
    for (const { baseUrl, origin } of OFF_PROJECT_BASE_URLS) {
        describe("given a plan that navigates to a relative path", () => {
            describe(`and a base URL of ${baseUrl}, whose origin the project does not declare`, () => {
                describe("when the run starts", () => {
                    test(`then it should refuse it with origin-not-allowed naming ${origin}, before any browser opens and with no manifest`, async () => {
                        const { result, recording } = await runPlan(planOf([OPEN_ORDERS]), {
                            baseUrl,
                        });
                        assert.equal(result.state, "Refused", JSON.stringify(result));
                        assert.deepEqual(result.refusal, { code: "origin-not-allowed", origin });
                        assert.deepEqual(result.steps, []);
                        assert.equal(result.manifest, null);
                        assert.equal(result.manifestHash, null);
                        assertNothingReached(recording);
                    });
                });
            });
        });
    }

    for (const baseUrl of ON_PROJECT_BASE_URLS) {
        describe("given a plan that navigates to a relative path", () => {
            describe(`and a base URL of ${baseUrl}, on an origin the project declares`, () => {
                describe("when the run starts", () => {
                    test("then it should open a browser, navigate and pass", async () => {
                        const { result, recording } = await runPlan(planOf([OPEN_ORDERS]), {
                            baseUrl,
                        });
                        assert.equal(result.refusal, undefined, JSON.stringify(result.refusal));
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                        assert.equal(recording.navigations.length, 1);
                    });
                });
            });
        });
    }
});
