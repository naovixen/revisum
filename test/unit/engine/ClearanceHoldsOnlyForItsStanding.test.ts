// A clearance is good only for what was judged. The gate's cleared run holds the standing it judged
// the plan as, so a plan cleared as approved cannot be run as anything else: cleared with no standing,
// or one lent from another plan, its barred actions are denied before any run, and a cleared run
// copied under another standing is refused before it acts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createRunService,
    policyGate,
    success,
    type ClearedRun,
    type Plan,
    type PlanStanding,
    type RunClearance,
} from "@revisum/engine";
import { memoryEventSink } from "../../support/memory-ports.ts";
import { baseUrlOf, trustedProjectFrom } from "../../support/policy-clearance.ts";
import { DATABASE_PASSWORD, fakeCommandRunner } from "./database-command-examples.ts";
import { TEST_SERVICE } from "./plan-examples.ts";
import { PROPOSAL, approvedStanding, parsedPlan } from "./policy-examples.ts";
import { fakeSessionOnOrders } from "./RunOnFakeSession.ts";
import { routedServiceCaller } from "./service-call-examples.ts";
import { matcher, setStorage, startStub } from "./stub-and-storage-examples.ts";
import { DEFAULT_CLOCK_START, DEFAULT_SEED } from "./run-value-examples.ts";
import { parsedProject, sourceBytes } from "./unsafe-feature-examples.ts";
import {
    CLEAR_EDITOR,
    DATABASE_SECRET,
    FEATURES,
    INLINE_READ,
    OPEN_CART,
    ORIGIN,
    SEED_EDITOR,
    TARGET_ID,
    WIPE_ORDERS,
    unsafePlan,
    unsafeProjectFile,
    type JsonRecord,
} from "./unsafe-feature-steps.ts";
import { fakeDriverOpening } from "#test-support/fakes/FakeDriver.ts";
import { fakeNetworkPort } from "#test-support/fakes/FakeNetworkPort.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { fakeSecretStore } from "#test-support/fakes/FakeSecretStore.ts";
import { fakeStoragePort } from "#test-support/fakes/FakeStoragePort.ts";

const ENGLISH_TARGET: JsonRecord = {
    id: TARGET_ID,
    adapter: "cdp",
    engine: "chromium",
    device: "desktop-1280",
    locale: "en-GB",
    timezone: "Europe/London",
    colorScheme: "light",
    reducedMotion: "reduce",
};

const BARRED_DECLARATIONS: JsonRecord = {
    matrix: [ENGLISH_TARGET],
    stubs: {
        barredStub: {
            request: matcher(ORIGIN, "POST", "/api/barred", "exact"),
            parameters: {},
            responses: [{ status: 200, mediaType: "text/plain", body: { text: "stubbed" } }],
            allowInProposals: false,
        },
    },
    storageEntries: {
        barredEntry: {
            area: "local",
            origin: ORIGIN,
            key: "barred",
            access: "readWrite",
            value: "yes",
            allowInProposals: false,
        },
    },
    calls: {
        barredCall: {
            service: TEST_SERVICE["name"],
            method: "POST",
            path: "/api/reset",
            parameters: {},
            effect: "write",
            successStatuses: [200],
            fields: {},
            allowInProposals: false,
        },
    },
};
const BARRED_PROJECT = unsafeProjectFile(FEATURES, BARRED_DECLARATIONS);

type Effects = {
    scripts: number;
    stubsStarted: number;
    storageWrites: number;
    readonly commands: () => number;
    readonly serviceCalls: () => number;
};
type EffectName = "scripts" | "stubsStarted" | "storageWrites" | "commands" | "serviceCalls";
const countOf = (effects: Effects, name: EffectName): number => {
    if (name === "commands") {
        return effects.commands();
    }
    return name === "serviceCalls" ? effects.serviceCalls() : effects[name];
};

// The run's whole page, where each thing the plan may do is counted as it happens. `refused` is the
// error the run threw, or null when it ran.
async function runOnCountingSession(
    cleared: ClearedRun,
): Promise<{ readonly effects: Effects; readonly refused: unknown }> {
    const commandRunner = fakeCommandRunner();
    const services = routedServiceCaller();
    const effects: Effects = {
        scripts: 0,
        stubsStarted: 0,
        storageWrites: 0,
        commands: () => commandRunner.commands.length,
        serviceCalls: () => services.requests.length,
    };
    const storage = fakeStoragePort({
        write: () => {
            effects.storageWrites++;
            return Promise.resolve(success(undefined));
        },
    });
    const session = fakeSessionOnOrders({
        runScript: () => {
            effects.scripts++;
            return Promise.resolve(success(JSON.stringify({ count: 3, blocks: 1 })));
        },
        network: fakeNetworkPort({
            startStub: () => {
                effects.stubsStarted++;
                return Promise.resolve(success(undefined));
            },
        }),
        storage,
    });
    const driver = fakeDriverOpening(session);
    const ports = fakePorts({
        drivers: driversOf(driver),
        secrets: fakeSecretStore({ [DATABASE_SECRET]: DATABASE_PASSWORD }),
        services: services.caller,
        databaseCommands: commandRunner.port,
    });
    let refused: unknown = null;
    try {
        await createRunService(ports).run(cleared, {
            baseUrl: baseUrlOf(ORIGIN),
            seed: DEFAULT_SEED,
            fixedTimeMilliseconds: DEFAULT_CLOCK_START,
            fixtures: [],
            host: { platform: "test", arch: "test" },
            scriptSources: sourceBytes(),
        });
    } catch (error) {
        refused = error;
    }
    return { effects, refused };
}

async function clearanceOf(plan: Plan, standing: PlanStanding | undefined): Promise<RunClearance> {
    const trusted = await trustedProjectFrom(BARRED_PROJECT);
    const [target] = parsedProject(BARRED_PROJECT).matrix;
    assert.ok(target !== undefined, "the test project has a target");
    return policyGate({ project: trusted, events: memoryEventSink() }).clear(
        plan,
        target.id,
        standing,
    );
}

async function clearedWith(plan: Plan, standing: PlanStanding | undefined): Promise<ClearedRun> {
    const decision = await clearanceOf(plan, standing);
    assert.equal(decision.kind, "allow", JSON.stringify(decision));
    return decision.run;
}

const REFUSED_AS_NOT_CLEARED = {
    name: "TypeError",
    message: "refused a run that the policy gate did not clear",
};

const BARRED_ACTIONS: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly effect: EffectName;
}[] = [
    { name: "an inline script", step: INLINE_READ, effect: "scripts" },
    { name: "a write script barred from proposals", step: CLEAR_EDITOR, effect: "scripts" },
    { name: "a write command barred from proposals", step: WIPE_ORDERS, effect: "commands" },
    {
        name: "a write call barred from proposals",
        step: { type: "call", call: "barredCall", arguments: {} },
        effect: "serviceCalls",
    },
    { name: "a stub barred from proposals", step: startStub("barredStub"), effect: "stubsStarted" },
    {
        name: "a storage write barred from proposals",
        step: setStorage("barredEntry"),
        effect: "storageWrites",
    },
];

describe("Using the policy gate and the run", () => {
    for (const { name, step, effect } of BARRED_ACTIONS) {
        const plan = (): Plan => parsedPlan(unsafePlan([OPEN_CART, step]), BARRED_PROJECT);

        describe(`given a plan with ${name}`, () => {
            describe("and no standing", () => {
                describe("when the gate clears it", () => {
                    test("then it should deny it, so no run of it exists", async () => {
                        const decision = await clearanceOf(plan(), undefined);
                        assert.equal(decision.kind, "deny", JSON.stringify(decision));
                    });
                });
            });

            describe("and an approval lent from another plan", () => {
                describe("when the gate clears it", () => {
                    test("then it should deny it as the proposal it is", async () => {
                        const another = parsedPlan(
                            unsafePlan([{ type: "navigate", url: "/other" }]),
                            BARRED_PROJECT,
                        );
                        const decision = await clearanceOf(plan(), await approvedStanding(another));
                        assert.equal(decision.kind, "deny", JSON.stringify(decision));
                    });
                });
            });

            describe("and its own approval", () => {
                describe("when the run cleared as approved is copied with no standing", () => {
                    test("then it should refuse the copy and not execute it", async () => {
                        const parsed = plan();
                        const cleared = await clearedWith(parsed, await approvedStanding(parsed));
                        const copied = { ...cleared, standing: PROPOSAL } as ClearedRun;
                        const { effects, refused } = await runOnCountingSession(copied);
                        assert.throws(() => {
                            throw refused;
                        }, REFUSED_AS_NOT_CLEARED);
                        assert.equal(countOf(effects, effect), 0);
                    });
                });

                describe("when the run cleared as approved runs", () => {
                    test("then it should execute it", async () => {
                        const parsed = plan();
                        const cleared = await clearedWith(parsed, await approvedStanding(parsed));
                        const { effects, refused } = await runOnCountingSession(cleared);
                        assert.equal(refused, null);
                        assert.equal(countOf(effects, effect), 1);
                    });
                });
            });
        });
    }

    describe("given a write script its declaration allows in proposals", () => {
        describe("when the run cleared as a proposal runs", () => {
            test("then it should execute it", async () => {
                const parsed = parsedPlan(unsafePlan([OPEN_CART, SEED_EDITOR]), BARRED_PROJECT);
                const { effects, refused } = await runOnCountingSession(
                    await clearedWith(parsed, undefined),
                );
                assert.equal(refused, null);
                assert.equal(effects.scripts, 1);
            });
        });
    });
});
