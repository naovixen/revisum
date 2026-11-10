// The proxy's rules arrive as plain data, from a policy or across a container boundary, so one parser
// reads them all: a rule the proxy could not honour is refused there with a failed outcome, and a proxy
// starts only from rules that went through it. A refusal says what kind it is and where, and never
// repeats the value it refused, which may hold a credential.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseProxyRules, proxyRules, readProxyRules } from "@revisum/runner";
import type { EgressPolicy, Origin } from "@revisum/contracts";
import { origin } from "../../examples/DeclaredService.ts";

const DECLARED = "http://declared.test";
const UNDECLARED = "http://undeclared.test";
const SECRET = "hunter2";
const ORIGIN_WITH_A_PASSWORD = `http://user:${SECRET}@x.test/`;
const HOST_WITH_A_PASSWORD = `user:${SECRET}@x.test`;
const RELAY_HOST = "database.test";
const RELAY_PORT = 5432;
const REWRITE = { name: "body-changed", find: "reached", replace: "rewritten" };
const UNPRINTABLE = { toString: 1 };
const NOT_JSON = /not JSON/;

const rules = (overrides: Record<string, unknown>): Record<string, unknown> => ({
    allowedOrigins: [DECLARED],
    privateOrigins: [],
    rewrites: [],
    ...overrides,
});

const rewriteRuleOn = (rewriteOrigin: unknown): Record<string, unknown> => ({
    origin: rewriteOrigin,
    rewrite: REWRITE,
});

const REFUSED: readonly {
    readonly title: string;
    readonly raw: unknown;
    readonly path: RegExp;
    readonly neverRepeated: string;
}[] = [
    {
        title: "a rewrite on an undeclared origin",
        raw: rules({ rewrites: [rewriteRuleOn(UNDECLARED)] }),
        path: /rewrites\W*0/,
        neverRepeated: UNDECLARED,
    },
    {
        title: "a rule origin that is not a URL",
        raw: rules({ allowedOrigins: ["not a url"] }),
        path: /allowedOrigins\W*0/,
        neverRepeated: "not a url",
    },
    {
        title: "a private origin that is not a URL",
        raw: rules({ privateOrigins: ["not a url"] }),
        path: /privateOrigins\W*0/,
        neverRepeated: "not a url",
    },
    {
        title: "a rewrite on a declared HTTPS origin",
        raw: rules({
            allowedOrigins: ["https://declared.test"],
            rewrites: [rewriteRuleOn("https://declared.test")],
        }),
        path: /rewrites\W*0/,
        neverRepeated: "https://declared.test",
    },
    {
        title: "something that is not rules at all",
        raw: "not rules",
        path: /allowedOrigins/,
        neverRepeated: "not rules",
    },
    {
        title: "a password in the second allowed origin",
        raw: rules({ allowedOrigins: [DECLARED, ORIGIN_WITH_A_PASSWORD] }),
        path: /allowedOrigins\W*1/,
        neverRepeated: SECRET,
    },
    {
        title: "a password in a private origin",
        raw: rules({ privateOrigins: [ORIGIN_WITH_A_PASSWORD] }),
        path: /privateOrigins\W*0/,
        neverRepeated: SECRET,
    },
    {
        title: "a password in a rewrite's origin",
        raw: rules({ rewrites: [rewriteRuleOn(ORIGIN_WITH_A_PASSWORD)] }),
        path: /rewrites\W*0/,
        neverRepeated: SECRET,
    },
    {
        title: "a rewrite on a declared origin that is not a name, find and replace",
        raw: rules({ rewrites: [{ origin: DECLARED, rewrite: { name: "only a name" } }] }),
        path: /rewrites\W*0/,
        neverRepeated: DECLARED,
    },
    {
        title: "a rewrite that finds nothing",
        raw: rules({
            rewrites: [{ origin: DECLARED, rewrite: { name: "empty", find: "", replace: "x" } }],
        }),
        path: /rewrites\W*0/,
        neverRepeated: DECLARED,
    },
    {
        title: "a password in a TCP relay's host",
        raw: rules({
            tcpRelays: [{ host: HOST_WITH_A_PASSWORD, port: RELAY_PORT, private: true }],
        }),
        path: /tcpRelays\W*0/,
        neverRepeated: SECRET,
    },
    {
        title: "a TCP relay with no port",
        raw: rules({ tcpRelays: [{ host: RELAY_HOST, private: true }] }),
        path: /tcpRelays\W*0/,
        neverRepeated: RELAY_HOST,
    },
    {
        title: "a TCP relay that does not say whether it is private",
        raw: rules({ tcpRelays: [{ host: RELAY_HOST, port: RELAY_PORT }] }),
        path: /tcpRelays\W*0/,
        neverRepeated: RELAY_HOST,
    },
    {
        title: "an origin on a scheme the proxy does not forward",
        raw: rules({ allowedOrigins: ["ftp://x.test"] }),
        path: /allowedOrigins\W*0/,
        neverRepeated: "ftp://x.test",
    },
];

const UNPRINTABLE_VALUES: readonly { readonly title: string; readonly raw: unknown }[] = [
    { title: "an allowed origin", raw: rules({ allowedOrigins: [UNPRINTABLE] }) },
    { title: "a private origin", raw: rules({ privateOrigins: [UNPRINTABLE] }) },
    { title: "a rewrite's origin", raw: rules({ rewrites: [rewriteRuleOn(UNPRINTABLE)] }) },
    {
        title: "a TCP relay's host",
        raw: rules({ tcpRelays: [{ host: UNPRINTABLE, port: RELAY_PORT, private: true }] }),
    },
];

const handBuiltPolicy = (allowOrigins: readonly Origin[], rewriteOrigin: Origin): EgressPolicy => ({
    allowOrigins,
    allowServices: [],
    allowTcpServices: [],
    denyPrivateRanges: true,
    responseRewrites: [{ origin: rewriteOrigin, rewrite: REWRITE }],
});

describe("Using the proxy's rules parser", () => {
    for (const { title, raw, path, neverRepeated } of REFUSED) {
        describe(`given ${title}`, () => {
            describe("when it is parsed", () => {
                test("then it should give a failed outcome with a code and a path, never the value", () => {
                    const parsed = parseProxyRules(raw);
                    assert.ok(!parsed.ok, JSON.stringify(parsed));
                    assert.equal(typeof parsed.error.code, "string");
                    assert.notEqual(parsed.error.code, "");
                    assert.match(parsed.error.path, path);
                    assert.ok(!parsed.error.message.includes(neverRepeated), parsed.error.message);
                    assert.ok(
                        !JSON.stringify(parsed.error).includes(neverRepeated),
                        JSON.stringify(parsed.error),
                    );
                });
            });
        });
    }

    for (const { title, raw } of UNPRINTABLE_VALUES) {
        describe(`given ${title} whose toString cannot be called`, () => {
            describe("when it is parsed", () => {
                test("then it should give a failed outcome and not throw", () => {
                    const parsed = parseProxyRules(raw);
                    assert.ok(!parsed.ok, JSON.stringify(parsed));
                    assert.equal(typeof parsed.error.code, "string");
                });
            });
        });
    }

    for (const scheme of ["http", "https"]) {
        describe(`given an allowed origin on ${scheme}`, () => {
            describe("when it is parsed", () => {
                test("then it should accept it", () => {
                    const parsed = parseProxyRules(
                        rules({ allowedOrigins: [`${scheme}://x.test`] }),
                    );
                    assert.ok(parsed.ok, JSON.stringify(parsed));
                });
            });
        });
    }

    describe("given rules whose every part is valid", () => {
        describe("and that name no TCP relays", () => {
            describe("when they are parsed", () => {
                test("then it should accept them, keep them as given and read no relays", () => {
                    const raw = rules({ rewrites: [rewriteRuleOn(DECLARED)] });
                    const parsed = parseProxyRules(raw);
                    assert.ok(parsed.ok, JSON.stringify(parsed));
                    assert.deepEqual({ ...parsed.value }, { ...raw, tcpRelays: [] });
                });
            });
        });

        describe("and that name a TCP relay", () => {
            describe("when they are parsed", () => {
                test("then it should keep the relay as given", () => {
                    const relay = { host: RELAY_HOST, port: RELAY_PORT, private: true };
                    const parsed = parseProxyRules(rules({ tcpRelays: [relay] }));
                    assert.ok(parsed.ok, JSON.stringify(parsed));
                    assert.deepEqual(parsed.value.tcpRelays, [relay]);
                });
            });
        });
    });

    describe("given the text of rules that the parser would refuse", () => {
        describe("when the proxy's container reads it", () => {
            test("then it should give the same failed outcome", () => {
                const raw = rules({ rewrites: [rewriteRuleOn(UNDECLARED)] });
                const read = readProxyRules(JSON.stringify(raw));
                assert.ok(!read.ok, JSON.stringify(read));
                assert.deepEqual(read, parseProxyRules(raw));
                assert.ok(!read.error.message.includes(UNDECLARED), read.error.message);
            });
        });
    });

    describe("given JSON text holding a value whose toString cannot be called", () => {
        describe("when the proxy's container reads it", () => {
            test("then it should say what is wrong with the rule, not that the text is not JSON", () => {
                const read = readProxyRules(
                    JSON.stringify(rules({ allowedOrigins: [UNPRINTABLE] })),
                );
                assert.ok(!read.ok, JSON.stringify(read));
                assert.doesNotMatch(read.error.message, NOT_JSON);
                assert.match(read.error.path, /allowedOrigins\W*0/);
            });
        });
    });

    describe("given text that is not JSON", () => {
        describe("when the proxy's container reads it", () => {
            test("then it should say that it is not JSON, without repeating it", () => {
                const read = readProxyRules(`{ ${SECRET}`);
                assert.ok(!read.ok, JSON.stringify(read));
                assert.match(read.error.message, NOT_JSON);
                assert.equal(typeof read.error.code, "string");
                assert.ok(!JSON.stringify(read.error).includes(SECRET), read.error.message);
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
