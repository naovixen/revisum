// A clearance is good only for what was judged. A plan the gate cleared because it was approved must
// not act as approved in a run that has no standing, or one lent from another plan.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    DRIVER_FEATURES,
    defaultRedactor,
    environmentSecretStore,
    policyGate,
    run,
    success,
    type Authorised,
    type BrowserDriver,
    type Plan,
    type PlanStanding,
    type RunPorts,
    type StoragePort,
} from "@revisum/engine";
import {
    memoryArtifactStore,
    memoryEventSink,
    memoryRunEventSink,
} from "../../support/memory-ports.ts";
import { trustedProjectFrom } from "../../support/policy-clearance.ts";
import { DATABASE_PASSWORD, fakeCommandRunner } from "./database-command-examples.ts";
import { TEST_SERVICE } from "./plan-examples.ts";
import { PROPOSAL, approvedStanding, parsedPlan } from "./policy-examples.ts";
import { fakeNetwork, fakeSession } from "./RunOnFakeSession.ts";
import { fakeServiceCaller, virtualClock } from "./service-call-examples.ts";
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

// The run's whole page, where each thing the plan may do is counted as it happens.
async function runOnCountingSession(
    authorised: Authorised,
    standing: PlanStanding | undefined,
): Promise<Effects> {
    const commandRunner = fakeCommandRunner();
    const services = fakeServiceCaller();
    const effects: Effects = {
        scripts: 0,
        stubsStarted: 0,
        storageWrites: 0,
        commands: () => commandRunner.commands.length,
        serviceCalls: () => services.requests.length,
    };
    const storage: StoragePort = {
        write: () => {
            effects.storageWrites++;
            return Promise.resolve(success(undefined));
        },
        remove: () => Promise.resolve(success(undefined)),
        read: () => Promise.resolve(success(null)),
    };
    const session = fakeSession({
        runScript: () => {
            effects.scripts++;
            return Promise.resolve(success(JSON.stringify({ count: 3, blocks: 1 })));
        },
        network: {
            ...fakeNetwork(),
            startStub: () => {
                effects.stubsStarted++;
                return Promise.resolve(success(undefined));
            },
        },
        storage,
    });
    const driver: BrowserDriver = {
        info: { id: "cdp", version: "counting", protocol: "none", performs: DRIVER_FEATURES },
        supports: () => success(true),
        open: () => Promise.resolve(success(session)),
    };
    const ports: RunPorts = {
        drivers: new Map([[driver.info.id, driver]]),
        clock: virtualClock(),
        artifacts: memoryArtifactStore(),
        redactor: defaultRedactor(),
        audit: memoryEventSink(),
        events: memoryRunEventSink(),
        secrets: environmentSecretStore({ [DATABASE_SECRET]: DATABASE_PASSWORD }),
        services: services.caller,
        databaseCommands: commandRunner.port,
    };
    const project = parsedProject(BARRED_PROJECT);
    const target = project.matrix[0];
    assert.ok(target !== undefined, "the test project has a target");
    try {
        await run(
            {
                plan: authorised,
                project,
                targetId: target.id,
                baseUrl: ORIGIN,
                seed: DEFAULT_SEED,
                fixedTimeMilliseconds: DEFAULT_CLOCK_START,
                fixtures: [],
                host: { platform: "test", arch: "test" },
                scriptSources: sourceBytes(),
                ...(standing === undefined ? {} : { standing }),
            },
            ports,
        );
    } catch {
        // Refusing by throwing is one way of not acting; only what reached the page is judged here.
    }
    return effects;
}

async function clearedWith(plan: Plan, standing: PlanStanding): Promise<Authorised> {
    const trusted = await trustedProjectFrom(BARRED_PROJECT);
    const targets = trusted.matrix.filter((target) => plan.targets.includes(target.id));
    const decision = policyGate({ project: trusted, events: memoryEventSink() }).decide(
        plan,
        targets,
        standing,
    );
    assert.equal(decision.kind, "allow", JSON.stringify(decision));
    return decision.plan;
}

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

        describe(`given a plan with ${name}, cleared as approved`, () => {
            describe("and the run is given no standing", () => {
                describe("when it runs", () => {
                    test(`then it should not execute it`, async () => {
                        const parsed = plan();
                        const authorised = await clearedWith(
                            parsed,
                            await approvedStanding(parsed),
                        );
                        const effects = await runOnCountingSession(authorised, undefined);
                        assert.equal(countOf(effects, effect), 0);
                    });
                });
            });

            describe("and the run is given a standing lent from another plan", () => {
                describe("when it runs", () => {
                    test(`then it should not execute it`, async () => {
                        const parsed = plan();
                        const authorised = await clearedWith(
                            parsed,
                            await approvedStanding(parsed),
                        );
                        const another = parsedPlan(
                            unsafePlan([{ type: "navigate", url: "/other" }]),
                            BARRED_PROJECT,
                        );
                        const lent = await approvedStanding(another);
                        const effects = await runOnCountingSession(authorised, lent);
                        assert.equal(countOf(effects, effect), 0);
                    });
                });
            });

            describe("and the run is given the plan's own approval", () => {
                describe("when it runs", () => {
                    test(`then it should execute it`, async () => {
                        const parsed = plan();
                        const standing = await approvedStanding(parsed);
                        const authorised = await clearedWith(parsed, standing);
                        const effects = await runOnCountingSession(authorised, standing);
                        assert.equal(countOf(effects, effect), 1);
                    });
                });
            });
        });
    }

    describe("given a write script its declaration allows in proposals, cleared as a proposal", () => {
        describe("and the run is given no standing", () => {
            describe("when it runs", () => {
                test("then it should execute it", async () => {
                    const parsed = parsedPlan(unsafePlan([OPEN_CART, SEED_EDITOR]), BARRED_PROJECT);
                    const authorised = await clearedWith(parsed, PROPOSAL);
                    const effects = await runOnCountingSession(authorised, undefined);
                    assert.equal(effects.scripts, 1);
                });
            });
        });
    });
});
