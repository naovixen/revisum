// A planner's reply is unknown until it is read, and the reply reader promises an answer for every
// value of that type. The body the adapter hands over is bytes, but a value that throws when asked
// what it is can still reach the reader in memory, and is refused as no JSON at all.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { PLANNER_WIRES, plannerReplyText } from "@revisum/engine";
import {
    listWithoutPrototype,
    proxyThatThrows,
    revokedProxy,
    withThrowingGetter,
} from "#test-support/ProxyThatThrows.ts";

const REPLY_NOT_JSON = { ok: false, error: { code: "reply-not-json" } };

const HOSTILE_REPLIES: readonly { readonly name: string; readonly hostile: () => unknown }[] = [
    {
        name: "an object whose field has a getter that throws",
        hostile: () => withThrowingGetter({}, "content"),
    },
    { name: "a list with no prototype", hostile: () => listWithoutPrototype([]) },
    {
        name: "a proxy over bytes that throws on every read",
        hostile: () => proxyThatThrows(new Uint8Array(1)),
    },
    {
        name: "a proxy over an object that throws on every read",
        hostile: () => proxyThatThrows({}),
    },
    { name: "a revoked proxy over bytes", hostile: () => revokedProxy(new Uint8Array(1)) },
    { name: "a revoked proxy over an object", hostile: () => revokedProxy({}) },
];

describe("Using the planner reply reader", () => {
    for (const wire of PLANNER_WIRES) {
        for (const { name, hostile } of HOSTILE_REPLIES) {
            describe(`given ${name} as the ${wire} reply`, () => {
                describe("when its text is read", () => {
                    test("then it should refuse it as not JSON without throwing", () => {
                        const reply = hostile();
                        let answer: unknown;
                        assert.doesNotThrow(() => {
                            answer = plannerReplyText(wire, reply);
                        });
                        assert.deepEqual(answer, REPLY_NOT_JSON);
                    });
                });
            });
        }
    }
});
