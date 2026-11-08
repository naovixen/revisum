// The proxy's rules arrive as plain data, from a policy or across a container boundary, so one parser
// reads them all: a rule the proxy could not honour is refused there with a failed outcome, and a proxy
// starts only from rules that went through it.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseProxyRules, proxyRules, readProxyRules } from "@revisum/runner";
import type { EgressPolicy, Origin } from "@revisum/contracts";
import { origin } from "./runner-examples.ts";

const DECLARED = "http://declared.test";
const UNDECLARED = "http://undeclared.test";
const REWRITE = { name: "body-changed", find: "reached", replace: "rewritten" };

const rules = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    allowedOrigins: [DECLARED],
    privateOrigins: [],
    rewrites: [],
    ...overrides,
});

const REFUSED: readonly {
    readonly title: string;
    readonly raw: unknown;
    readonly namedInMessage: string;
}[] = [
    {
        title: "a rewrite on an undeclared origin",
        raw: rules({ rewrites: [{ origin: UNDECLARED, rewrite: REWRITE }] }),
        namedInMessage: UNDECLARED,
    },
    {
        title: "a rule origin that is not a URL",
        raw: rules({ allowedOrigins: ["not a url"] }),
        namedInMessage: "not a url",
    },
    {
        title: "a private origin that is not a URL",
        raw: rules({ privateOrigins: ["not a url"] }),
        namedInMessage: "not a url",
    },
    {
        title: "a rewrite on a declared HTTPS origin",
        raw: rules({
            allowedOrigins: ["https://declared.test"],
            rewrites: [{ origin: "https://declared.test", rewrite: REWRITE }],
        }),
        namedInMessage: "https://declared.test",
    },
    { title: "something that is not rules at all", raw: "not rules", namedInMessage: "" },
];

const handBuiltPolicy = (allowOrigins: readonly Origin[], rewriteOrigin: Origin): EgressPolicy => ({
    allowOrigins,
    allowServices: [],
    allowTcpServices: [],
    denyPrivateRanges: true,
    responseRewrites: [{ origin: rewriteOrigin, rewrite: REWRITE }],
});

describe("Using the proxy's rules parser", () => {
    for (const { title, raw, namedInMessage } of REFUSED) {
        describe(`given ${title}`, () => {
            describe("when it is parsed", () => {
                test("then it should give a failed outcome saying why", () => {
                    const parsed = parseProxyRules(raw);
                    assert.ok(!parsed.ok, JSON.stringify(parsed));
                    assert.ok(parsed.error.message.includes(namedInMessage), parsed.error.message);
                });
            });
        });
    }

    describe("given rules whose every part is valid", () => {
        describe("when they are parsed", () => {
            test("then it should accept them and keep them as given", () => {
                const raw = rules({ rewrites: [{ origin: DECLARED, rewrite: REWRITE }] });
                const parsed = parseProxyRules(raw);
                assert.ok(parsed.ok, JSON.stringify(parsed));
                assert.deepEqual({ ...parsed.value }, raw);
            });
        });
    });

    describe("given the text of rules that the parser would refuse", () => {
        describe("when the proxy's container reads it", () => {
            test("then it should give the same failed outcome", () => {
                const read = readProxyRules(
                    JSON.stringify(rules({ rewrites: [{ origin: UNDECLARED, rewrite: REWRITE }] })),
                );
                assert.ok(!read.ok, JSON.stringify(read));
                assert.ok(read.error.message.includes(UNDECLARED), read.error.message);
            });
        });
    });

    describe("given a policy built by hand with a rewrite on an undeclared origin", () => {
        describe("when its rules are drawn", () => {
            test("then it should give a failed outcome", () => {
                const drawn = proxyRules(handBuiltPolicy([origin(DECLARED)], origin(UNDECLARED)));
                assert.ok(!drawn.ok, JSON.stringify(drawn));
            });
        });
    });
});
