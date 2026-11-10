// The policy builder refuses a fixture origin that is undeclared or not plain HTTP, each with its own
// error code, which its anchor in docs/errors.md explains. fixture-origin-policy.test.ts shows what is
// refused; this pins the code each refusal gives, exactly, and that a rewrite outside the fixture
// origins keeps the code it always had.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FixtureRewrite, Origin } from "@revisum/contracts";
import { buildEgressPolicy, type ResponseRewrite } from "@revisum/runner";
import { origin } from "../../examples/DeclaredService.ts";

const PLAIN = origin("http://fixture.test");
const SECURE = origin("https://fixture.test");
const SOCKET = origin("ws://fixture.test");
const UNDECLARED = origin("http://undeclared.test");
const REWRITE: ResponseRewrite = { name: "body-changed", find: "reached", replace: "rewritten" };
const rewriteOn = (fixture: Origin): FixtureRewrite => ({ origin: fixture, rewrite: REWRITE });

const REFUSALS: readonly {
    readonly title: string;
    readonly allowOrigins: readonly Origin[];
    readonly fixture: Origin;
    readonly code: string;
}[] = [
    {
        title: "an undeclared fixture origin",
        allowOrigins: [PLAIN],
        fixture: UNDECLARED,
        code: "fixture-origin-undeclared",
    },
    {
        title: "a declared HTTPS fixture origin",
        allowOrigins: [SECURE],
        fixture: SECURE,
        code: "fixture-origin-not-plain-http",
    },
    {
        title: "a declared WebSocket fixture origin",
        allowOrigins: [SOCKET],
        fixture: SOCKET,
        code: "fixture-origin-not-plain-http",
    },
];

for (const { title, allowOrigins, fixture, code } of REFUSALS) {
    test(`${title} is refused as ${code}, naming the origin`, () => {
        const built = buildEgressPolicy({
            allowOrigins,
            allowServices: [],
            fixtureOrigins: [fixture],
        });
        assert.deepEqual(built, { ok: false, error: { code, origin: fixture } });
    });

    test(`${title} with a rewrite on it is refused as ${code}, not as a rewrite outside the fixtures`, () => {
        const built = buildEgressPolicy({
            allowOrigins,
            allowServices: [],
            fixtureOrigins: [fixture],
            responseRewrites: [rewriteOn(fixture)],
        });
        assert.deepEqual(built, { ok: false, error: { code, origin: fixture } });
    });
}

test("counter-example: a rewrite on a declared origin that is not a fixture keeps rewrite-origin-not-fixture", () => {
    const other = origin("http://other.test");
    const built = buildEgressPolicy({
        allowOrigins: [PLAIN, other],
        allowServices: [],
        fixtureOrigins: [PLAIN],
        responseRewrites: [rewriteOn(other)],
    });
    assert.deepEqual(built, {
        ok: false,
        error: { code: "rewrite-origin-not-fixture", origin: other },
    });
});

test("counter-example: a declared plain-HTTP fixture origin gives no refusal code at all", () => {
    const built = buildEgressPolicy({
        allowOrigins: [PLAIN],
        allowServices: [],
        fixtureOrigins: [PLAIN],
        responseRewrites: [rewriteOn(PLAIN)],
    });
    assert.equal(built.ok, true, JSON.stringify(built));
});
