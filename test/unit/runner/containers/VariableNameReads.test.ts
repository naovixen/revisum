// A variable name is a checked value, so a name that isn't one can never be passed by mistake.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { readVariableName } from "@revisum/runner";

describe("Using the variable name reader", () => {
    describe("given a name an environment can hold", () => {
        for (const name of ["PATH", "_private", "SHOP_API_TOKEN", "a".repeat(128)]) {
            describe(`when the name is ${name.slice(0, 20)}`, () => {
                test("then it should give it back", () => {
                    assert.equal(readVariableName(name), name);
                });
            });
        }
    });

    describe("given a name an environment cannot hold", () => {
        for (const name of [
            "",
            "1START",
            "WITH=SIGN",
            "WITH SPACE",
            "a".repeat(129),
            "WITH\nNEWLINE",
        ]) {
            describe(`when the name is ${JSON.stringify(name.slice(0, 20))}`, () => {
                test("then it should refuse it", () => {
                    assert.equal(readVariableName(name), null);
                });
            });
        }
    });

    // The run's own proxy is set by the run alone, so a project's secret can't move it.
    describe("given a name that would set the run's proxy", () => {
        for (const name of [
            "HTTP_PROXY",
            "http_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "ALL_PROXY",
            "all_proxy",
            "NO_PROXY",
            "no_proxy",
        ]) {
            describe(`when the name is ${name}`, () => {
                test("then it should refuse it", () => {
                    assert.equal(readVariableName(name), null);
                });
            });
        }
    });
});
