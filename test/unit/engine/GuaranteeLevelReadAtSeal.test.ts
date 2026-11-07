// A run reads its isolation's level as it seals its result, once its steps have ended and its
// browser has closed, since an isolated runner's level can fall to host only when the proxy's record
// proves incomplete. A level that falls before then is the level the result states.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRunService, GuaranteeLevel, planParser, type RunIsolation } from "@revisum/engine";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { baseUrlOf, clearRun, trustedProjectFrom } from "#test-support/policy-clearance.ts";
import { ORIGIN } from "./plan-examples.ts";
import {
    DEFAULT_CLOCK_START,
    DEFAULT_SEED,
    OPEN_ORDERS,
    accepted,
    planOf,
    projectFileWith,
    projectWith,
    recordingDriver,
} from "./run-value-examples.ts";

// An isolated runner's handle whose level falls to host once the browser has closed.
function isolationFallingAtClose(): {
    readonly isolation: RunIsolation;
    readonly close: () => void;
} {
    let level: GuaranteeLevel = GuaranteeLevel.Isolated;
    return {
        isolation: { guaranteeLevel: () => level },
        close: () => {
            level = GuaranteeLevel.Host;
        },
    };
}

async function runWith(isolation: RunIsolation, onClose: () => void) {
    const plan = accepted(planParser(projectWith()), planOf([OPEN_ORDERS]));
    const [targetId = assert.fail("the test plan declares a target")] = plan.targets;
    const cleared = clearRun(plan, await trustedProjectFrom(projectFileWith()), targetId);
    const { driver } = recordingDriver({
        close: () => {
            onClose();
            return Promise.resolve();
        },
    });
    return createRunService(fakePorts({ drivers: driversOf(driver), isolation })).run(cleared, {
        baseUrl: baseUrlOf(ORIGIN),
        seed: DEFAULT_SEED,
        fixedTimeMilliseconds: DEFAULT_CLOCK_START,
        fixtures: [],
        host: { platform: "test", arch: "test" },
    });
}

describe("Using the run", () => {
    describe("given an isolated runner whose level falls to host as the browser closes", () => {
        describe("when the run seals its result", () => {
            test("then it should state the host level, claiming no egress enforcement", async () => {
                const falling = isolationFallingAtClose();
                const result = await runWith(falling.isolation, falling.close);
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.equal(result.guarantees.level, "host");
                assert.equal(result.guarantees.holds.includes("egress-enforced"), false);
            });
        });
    });

    describe("given an isolated runner whose level holds", () => {
        describe("when the run seals its result", () => {
            test("then it should state that egress was enforced", async () => {
                const isolation: RunIsolation = { guaranteeLevel: () => GuaranteeLevel.Isolated };
                const result = await runWith(isolation, () => undefined);
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.equal(result.guarantees.holds.includes("egress-enforced"), true);
            });
        });
    });
});
