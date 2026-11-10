// A suite run's blocked origins are one list of what was refused. A request the browser saw and the
// tunnel the proxy refused for it are one refusal under two forms, "https://x" and "x:443", and the
// browser's form says more. What a run's events did not refuse stays out of the list.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EgressEvent } from "@revisum/contracts";
import { recordedReport } from "../../../engine/evidence/examples/EvidenceRun.ts";
import { runDeclaredSuite } from "./examples/SuiteRun.ts";
import { EgressDecision, EgressChannel } from "@revisum/contracts";

const blockedInBrowserForm = (origin: string): EgressEvent => ({
    origin,
    channel: EgressChannel.Page,
    decision: EgressDecision.Blocked,
});
const blockedByTheProxy = (origin: string): EgressEvent => ({
    origin,
    channel: EgressChannel.Unattributed,
    decision: EgressDecision.Blocked,
});
const allowedByTheProxy = (origin: string): EgressEvent => ({
    origin,
    channel: EgressChannel.Unattributed,
    decision: EgressDecision.Allowed,
});

const blockedOriginsOf = async (
    egressEvents: readonly EgressEvent[],
): Promise<readonly string[] | undefined> => {
    const { result } = await runDeclaredSuite({
        behaviour: { report: recordedReport("passing-with-criteria"), exitCode: 0, egressEvents },
    });
    return result.blockedOrigins;
};

describe("Using a suite run", () => {
    for (const { title, events, kept } of [
        {
            title: "a secure origin and the tunnel the proxy refused for it",
            events: [
                blockedInBrowserForm("https://outside.test"),
                blockedByTheProxy("outside.test:443"),
            ],
            kept: "https://outside.test",
        },
        {
            title: "the same two, with the proxy's first",
            events: [
                blockedByTheProxy("outside.test:443"),
                blockedInBrowserForm("https://outside.test"),
            ],
            kept: "https://outside.test",
        },
        {
            title: "a plain origin and the tunnel the proxy refused for it",
            events: [
                blockedInBrowserForm("http://outside.test"),
                blockedByTheProxy("outside.test:80"),
            ],
            kept: "http://outside.test",
        },
    ]) {
        describe(`given ${title}`, () => {
            describe("when the run lists its blocked origins", () => {
                test("then it should list the refusal once, in the browser's form", async () => {
                    assert.deepEqual(await blockedOriginsOf(events), [kept]);
                });
            });
        });
    }

    describe("given the same pair and a suite that wrote no report", () => {
        describe("when the run lists its blocked origins", () => {
            test("then it should still list the refusal once", async () => {
                const { result } = await runDeclaredSuite({
                    behaviour: {
                        exitCode: 0,
                        egressEvents: [
                            blockedInBrowserForm("https://outside.test"),
                            blockedByTheProxy("outside.test:443"),
                        ],
                    },
                });
                assert.deepEqual(result.blockedOrigins, ["https://outside.test"]);
            });
        });
    });

    describe("given a secure origin and a tunnel to the same host on another port", () => {
        describe("when the run lists its blocked origins", () => {
            test("then it should list both", async () => {
                assert.deepEqual(
                    await blockedOriginsOf([
                        blockedInBrowserForm("https://outside.test"),
                        blockedByTheProxy("outside.test:8443"),
                    ]),
                    ["https://outside.test", "outside.test:8443"],
                );
            });
        });
    });

    describe("given a refusal only the proxy saw", () => {
        describe("when the run lists its blocked origins", () => {
            test("then it should list it in the proxy's form", async () => {
                assert.deepEqual(await blockedOriginsOf([blockedByTheProxy("outside.test:443")]), [
                    "outside.test:443",
                ]);
            });
        });
    });

    describe("given a request the proxy allowed", () => {
        describe("when the run lists its blocked origins", () => {
            test("then it should leave it out", async () => {
                assert.deepEqual(await blockedOriginsOf([allowedByTheProxy("app.test:443")]), []);
            });
        });
    });
});
