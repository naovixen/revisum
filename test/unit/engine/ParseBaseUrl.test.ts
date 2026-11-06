// The base URL a run's relative paths resolve against is parsed once, where it enters: only an
// absolute http or https URL with no user name or password becomes one, kept exactly as written.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BaseUrlRefusal, baseUrlOfOrigin, failure, parseBaseUrl, success } from "@revisum/engine";
import { testProject } from "./plan-examples.ts";

const ACCEPTED: readonly string[] = [
    "http://127.0.0.1:4173",
    "https://app.example",
    "https://app.example/",
    "https://app.example/shop/",
    "https://app.example:8443/shop?tab=orders",
];

const REFUSED: readonly (readonly [string, unknown, BaseUrlRefusal])[] = [
    ["a number", 4173, BaseUrlRefusal.WrongType],
    ["nothing at all", undefined, BaseUrlRefusal.WrongType],
    ["a relative path", "/shop/", BaseUrlRefusal.InvalidUrl],
    ["a host with no scheme", "app.example", BaseUrlRefusal.InvalidUrl],
    ["an empty text", "", BaseUrlRefusal.InvalidUrl],
    ["a file URL", "file:///etc/passwd", BaseUrlRefusal.SchemeNotAllowed],
    ["a javascript URL", "javascript:alert(1)", BaseUrlRefusal.SchemeNotAllowed],
    ["a data URL", "data:text/html,hello", BaseUrlRefusal.SchemeNotAllowed],
    ["an ftp URL", "ftp://app.example/", BaseUrlRefusal.SchemeNotAllowed],
    ["a user name", "https://ada@app.example/", BaseUrlRefusal.CredentialsNotAllowed],
    [
        "a user name and password",
        "https://ada:secret@app.example/",
        BaseUrlRefusal.CredentialsNotAllowed,
    ],
    ["only a password", "https://:secret@app.example/", BaseUrlRefusal.CredentialsNotAllowed],
];

describe("Using the base URL parser", () => {
    for (const url of ACCEPTED) {
        describe(`given ${url}`, () => {
            describe("when it is parsed", () => {
                test("then it should accept it exactly as written", () => {
                    assert.deepEqual(parseBaseUrl(url), success(url));
                });
            });
        });
    }

    for (const [what, input, refusal] of REFUSED) {
        describe(`given ${what}`, () => {
            describe("when it is parsed", () => {
                test(`then it should refuse it with ${refusal}`, () => {
                    assert.deepEqual(parseBaseUrl(input), failure(refusal));
                });
            });
        });
    }

    describe("given an origin the project parser read", () => {
        describe("when it is taken as a base URL", () => {
            test("then it should be the base URL the parser gives for the same text", () => {
                const [origin = assert.fail("the test project declares an origin")] =
                    testProject().origins;
                assert.deepEqual(success(baseUrlOfOrigin(origin)), parseBaseUrl(origin));
            });
        });
    });
});
