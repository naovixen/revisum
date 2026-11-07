// A suite whose setup command fails or times out never runs, but the setup ran behind the egress
// proxy all the same. So its result says what the proxy refused during setup, and claims egress was
// enforced only when the proxy's record could be read, exactly as a suite run's result does.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EgressEvent } from "@revisum/contracts";
import { recordedReport } from "../engine/evidence-examples.ts";
import { runDeclaredSuite, type SuiteBehaviour } from "./suite-run-examples.ts";

const REFUSED_ORIGIN = "outside.test:443";

const blockedByTheProxy: EgressEvent = {
    origin: REFUSED_ORIGIN,
    channel: "unattributed",
    decision: "blocked",
};

const SETUP_ENDINGS: readonly {
    readonly name: string;
    readonly setup: NonNullable<SuiteBehaviour["setup"]>;
    readonly outcomeCode: string;
}[] = [
    { name: "exits 1", setup: { exitCode: 1 }, outcomeCode: "setup-failed" },
    { name: "times out", setup: { timedOut: true }, outcomeCode: "suite-timeout" },
];

const runWithSetup = (setup: SuiteBehaviour["setup"]) =>
    runDeclaredSuite({
        behaviour: {
            report: recordedReport("passing-with-criteria"),
            exitCode: 0,
            ...(setup === undefined ? {} : { setup }),
        },
    });

describe("Using a suite run", () => {
    for (const ending of SETUP_ENDINGS) {
        describe(`given a setup command that ${ending.name}`, () => {
            describe("and an egress proxy whose record cannot be read", () => {
                describe("when the run ends", () => {
                    test("then it should end Errored with its outcome code, claiming no enforced egress", async () => {
                        const { result } = await runWithSetup({
                            ...ending.setup,
                            egressRecordUnread: true,
                        });
                        assert.equal(result.state, "Errored");
                        assert.equal(result.evidence?.outcomeCode, ending.outcomeCode);
                        assert.equal(result.guarantees.holds.includes("egress-enforced"), false);
                    });
                });
            });

            describe("and an egress proxy that refused an origin", () => {
                describe("when the run ends", () => {
                    test("then it should end Errored with its outcome code, listing the refused origin", async () => {
                        const { result } = await runWithSetup({
                            ...ending.setup,
                            egressEvents: [blockedByTheProxy],
                        });
                        assert.equal(result.state, "Errored");
                        assert.equal(result.evidence?.outcomeCode, ending.outcomeCode);
                        assert.deepEqual(result.blockedOrigins, [REFUSED_ORIGIN]);
                        assert.equal(result.guarantees.holds.includes("egress-enforced"), true);
                    });
                });
            });
        });
    }

    describe("given a setup command that succeeds", () => {
        describe("and a suite whose egress proxy refused an origin", () => {
            describe("when the run ends", () => {
                test("then it should pass, listing the refused origin and claiming enforced egress", async () => {
                    const { result } = await runDeclaredSuite({
                        behaviour: {
                            report: recordedReport("passing-with-criteria"),
                            exitCode: 0,
                            egressEvents: [blockedByTheProxy],
                        },
                    });
                    assert.equal(result.state, "Passed");
                    assert.equal(result.evidence?.outcomeCode, undefined);
                    assert.deepEqual(result.blockedOrigins, [REFUSED_ORIGIN]);
                    assert.equal(result.guarantees.holds.includes("egress-enforced"), true);
                });
            });
        });
    });
});
