// A navigate step's URL that starts with "/" reads as a path on the run's base URL. Once dots are
// normalised, some such texts start with "//", which a browser resolves against another host, so
// the plan would read as relative while going elsewhere.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { accepted, navigate, parserFor, planOf, rejection } from "./examples/RunPlan.ts";

const parsePlan = parserFor();

const URLS_THAT_NORMALISE_TO_ANOTHER_HOST: readonly string[] = [
    "/.//evil.example/x",
    "/x/..//evil.example/y",
    "/%2e//evil.example/x",
    "/x/%2e%2e//evil.example/y",
    "/.\\/evil.example/x",
];

const URLS_THAT_STAY_ON_THE_BASE_ORIGIN: readonly {
    readonly written: string;
    readonly stored: string;
}[] = [
    { written: "/orders", stored: "/orders" },
    { written: "/orders/../cart", stored: "/cart" },
    { written: "/orders//items", stored: "/orders//items" },
];

const navigatedUrlOf = (written: string): unknown => {
    const firstStep = accepted(parsePlan, planOf([navigate(written)])).steps[0];
    assert.ok(firstStep.type === "navigate", "the first step is the navigate step");
    return firstStep.url;
};

describe("Using the plan parser", () => {
    for (const url of URLS_THAT_NORMALISE_TO_ANOTHER_HOST) {
        describe(`given a navigate step to ${url}`, () => {
            describe("when the plan is parsed", () => {
                test("then it should refuse the URL as invalid_url", () => {
                    assert.deepEqual(rejection(parsePlan, planOf([navigate(url)])), [
                        "invalid_url $.steps[0].url",
                    ]);
                });
            });
        });
    }

    for (const { written, stored } of URLS_THAT_STAY_ON_THE_BASE_ORIGIN) {
        describe(`given a navigate step to ${written}`, () => {
            describe("when the plan is parsed", () => {
                test("then it should keep the normalised path", () => {
                    assert.equal(navigatedUrlOf(written), stored);
                });
            });
        });
    }
});
