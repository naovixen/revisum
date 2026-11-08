// A crawl in a run container has no way out but the egress proxy that HTTP_PROXY names. Whether there
// is one is the ports' own question, answered before any browser is built: a blank value says there
// is no proxy, and must never be taken for a browser that would not start.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildAdapters } from "@revisum/cli";
import { type SecretName } from "@revisum/engine";

const HTTP_PROXY = "HTTP_PROXY";
const NO_EGRESS_PROXY = "no-egress-proxy";
const NO_SECRETS: readonly SecretName[] = [];

const portsWith = (environment: NodeJS.ProcessEnv) =>
    buildAdapters.containerCrawlPorts({
        executablePath: "never-launched",
        secretNames: NO_SECRETS,
        environment,
    });

const VALUES_NAMING_NO_PROXY: readonly {
    readonly name: string;
    readonly environment: NodeJS.ProcessEnv;
}[] = [
    { name: "unset", environment: {} },
    { name: "empty", environment: { [HTTP_PROXY]: "" } },
    { name: "a space", environment: { [HTTP_PROXY]: " " } },
    { name: "whitespace", environment: { [HTTP_PROXY]: "\t\n " } },
];

describe("Using the ports of a crawl in a container", () => {
    for (const { name, environment } of VALUES_NAMING_NO_PROXY) {
        describe(`given HTTP_PROXY is ${name}`, () => {
            describe("when the ports are built", () => {
                test("then it should say there is no proxy", () => {
                    assert.deepEqual(portsWith(environment), {
                        ok: false,
                        error: NO_EGRESS_PROXY,
                    });
                });
            });
        });
    }

    describe("given HTTP_PROXY names a proxy", () => {
        describe("when the ports are built", () => {
            test("then it should give ports with a browser", () => {
                const built = portsWith({ [HTTP_PROXY]: "http://127.0.0.1:9" });
                assert.ok(built.ok, JSON.stringify(built));
                assert.equal(typeof built.value.browser.open, "function");
            });
        });
    });
});
