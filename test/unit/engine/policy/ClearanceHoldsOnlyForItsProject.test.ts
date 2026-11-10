// A clearance is good only under the project that gave it. The gate must hold a plan to the project
// it clears it under, not the one it was parsed under: unsafe features, named scripts and secret
// names the clearing project does not declare are denied. And the run the gate clears holds that
// project: a copy of it under another project is refused before any browser opens.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createRunService, type ClearedRun } from "@revisum/engine";
import {
    finalState,
    guardedDriver,
    parserFor,
    runBase,
    runInputs,
} from "../run/examples/GuardedDriver.ts";
import {
    ALLOWED,
    PROPOSAL,
    approvedStanding,
    comparable,
    decideOn,
    parsedPlan,
    testGate,
} from "./examples/Policy.ts";
import {
    CLASS_CHECK,
    CSS_CHECK,
    DATABASE_SECRET,
    FEATURES,
    INLINE_READ,
    OPEN_CART,
    ORIGIN,
    PAGE_SCRIPTS,
    READ_CART,
    REMEMBER_ATTRIBUTE,
    TARGET_ID,
    XPATH_CHECK,
    unsafePlan,
    unsafeProjectFile,
    type JsonRecord,
} from "../plan/unsafe-features/examples/UnsafePlan.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { TEST_SERVICE_SECRET_NAMES } from "../plan/examples/GoldenPlan.ts";
import { baseUrlOf, clearRun, trustedProjectFrom } from "#test-support/builders/ClearRun.ts";
import { parsedProject, sourceBytes } from "../plan/unsafe-features/examples/LostByFeature.ts";

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

const LOOSER = unsafeProjectFile(FEATURES, {
    matrix: [ENGLISH_TARGET],
    secretNames: [
        ...TEST_SERVICE_SECRET_NAMES,
        DATABASE_SECRET,
        "ACCOUNT_PASSWORD",
        "SAVED_SESSION",
    ],
});
const STRICTER = unsafeProjectFile([], { matrix: [ENGLISH_TARGET] });
const STRICTER_SCRIPTS = unsafeProjectFile(["page-script"], {
    matrix: [ENGLISH_TARGET],
    unsafeFeatures: {
        pageScripts: {
            scripts: { seedEditor: PAGE_SCRIPTS["seedEditor"] },
            allowInline: false,
        },
    },
});

const SAME_FEATURE_EVERYWHERE = unsafeProjectFile(["css-locator"], { matrix: [ENGLISH_TARGET] });

const passwordFill: JsonRecord = {
    type: "fill",
    locator: { by: "label", label: "Password" },
    value: { secretName: "ACCOUNT_PASSWORD" },
};

const LOOSER_ONLY_PLANS: readonly { readonly name: string; readonly raw: JsonRecord }[] = [
    { name: "a css locator", raw: unsafePlan([OPEN_CART, CSS_CHECK]) },
    { name: "an xpath locator", raw: unsafePlan([OPEN_CART, XPATH_CHECK]) },
    { name: "a DOM check", raw: unsafePlan([OPEN_CART, CLASS_CHECK]) },
    { name: "a remembered attribute", raw: unsafePlan([OPEN_CART, REMEMBER_ATTRIBUTE]) },
    { name: "an inline script", raw: unsafePlan([OPEN_CART, INLINE_READ]) },
    { name: "a named script", raw: unsafePlan([OPEN_CART, READ_CART]) },
    { name: "a secret the project does not declare", raw: unsafePlan([OPEN_CART, passwordFill]) },
    {
        name: "saved storage state under a secret the project does not declare",
        raw: unsafePlan([OPEN_CART], { storageState: { secretName: "SAVED_SESSION" } }),
    },
];

async function decidedUnderStricter(
    raw: JsonRecord,
    parsedUnder: JsonRecord,
    clearedUnder: JsonRecord,
    standing: "approved" | "proposal",
) {
    const plan = parsedPlan(raw, parsedUnder);
    const tested = await testGate(clearedUnder);
    return comparable(
        decideOn(tested, plan, standing === "approved" ? await approvedStanding(plan) : PROPOSAL),
    );
}

describe("Using the policy gate", () => {
    for (const { name, raw } of LOOSER_ONLY_PLANS) {
        describe(`given an approved plan with ${name}, parsed under a looser project`, () => {
            describe("and cleared under a stricter project", () => {
                describe("when the plan is decided", () => {
                    test("then it should deny it", async () => {
                        const decision = await decidedUnderStricter(
                            raw,
                            LOOSER,
                            STRICTER,
                            "approved",
                        );
                        assert.equal(decision["kind"], "deny", JSON.stringify(decision));
                    });
                });
            });

            describe("and cleared under the same project", () => {
                describe("when the plan is decided", () => {
                    test("then it should allow it", async () => {
                        const decision = await decidedUnderStricter(
                            raw,
                            LOOSER,
                            LOOSER,
                            "approved",
                        );
                        assert.deepEqual(decision, ALLOWED);
                    });
                });
            });
        });
    }

    describe("given a proposal with a css locator, parsed under a looser project", () => {
        describe("and cleared under a stricter project", () => {
            describe("when the plan is decided", () => {
                test("then it should deny it", async () => {
                    const raw = unsafePlan([OPEN_CART, CSS_CHECK]);
                    const decision = await decidedUnderStricter(raw, LOOSER, STRICTER, "proposal");
                    assert.equal(decision["kind"], "deny", JSON.stringify(decision));
                });
            });
        });

        describe("and cleared under another project that enables css locators", () => {
            describe("when the plan is decided", () => {
                test("then it should allow it", async () => {
                    const raw = unsafePlan([OPEN_CART, CSS_CHECK]);
                    const decision = await decidedUnderStricter(
                        raw,
                        LOOSER,
                        SAME_FEATURE_EVERYWHERE,
                        "proposal",
                    );
                    assert.deepEqual(decision, ALLOWED);
                });
            });
        });
    });

    describe("given a plan with only closed steps, parsed under a looser project", () => {
        describe("and cleared under a stricter project", () => {
            describe("when the plan is decided", () => {
                test("then it should allow it", async () => {
                    const decision = await decidedUnderStricter(
                        unsafePlan([OPEN_CART]),
                        LOOSER,
                        STRICTER,
                        "proposal",
                    );
                    assert.deepEqual(decision, ALLOWED);
                });
            });
        });
    });

    describe("given an approved plan naming a script the running project does not declare", () => {
        const steps = [OPEN_CART, READ_CART];

        const untrustedRun = async (runProject: JsonRecord) => {
            const plan = parsedPlan(unsafePlan(steps), LOOSER);
            const guarded = guardedDriver(steps);
            const ports = fakePorts({ drivers: driversOf(guarded.driver) });
            const outcome = await createRunService(ports).runUntrusted(
                unsafePlan(steps),
                parserFor(LOOSER),
                {
                    ...runBase(runProject),
                    baseUrl: baseUrlOf(ORIGIN),
                    standing: await approvedStanding(plan),
                    scriptSources: sourceBytes(),
                },
            );
            return { state: finalState(outcome), opens: guarded.opens() };
        };

        describe("when it is run", () => {
            test("then it should be denied before any browser opens", async () => {
                assert.deepEqual(await untrustedRun(STRICTER_SCRIPTS), {
                    state: "Denied",
                    opens: 0,
                });
            });
        });
    });

    describe("given an approved plan naming a script the project declares", () => {
        describe("when the plan is decided", () => {
            test("then it should allow it", async () => {
                const raw = unsafePlan([OPEN_CART, READ_CART]);
                const decision = await decidedUnderStricter(raw, LOOSER, LOOSER, "approved");
                assert.deepEqual(decision, ALLOWED);
            });
        });
    });

    describe("given an approved plan with a css locator, cleared under a looser project", () => {
        const clearedUnderLooser = async (): Promise<ClearedRun> => {
            const plan = parsedPlan(unsafePlan([OPEN_CART, CSS_CHECK]), LOOSER);
            return clearRun(
                plan,
                await trustedProjectFrom(LOOSER),
                parsedProject(LOOSER).matrix[0]?.id ?? assert.fail("the project has a target"),
                await approvedStanding(plan),
            );
        };
        const runOn = (cleared: ClearedRun) => {
            const guarded = guardedDriver([OPEN_CART, CSS_CHECK]);
            const ran = createRunService(fakePorts({ drivers: driversOf(guarded.driver) })).run(
                cleared,
                runInputs(),
            );
            return { ran, opens: guarded.opens };
        };

        describe("when the cleared run is copied under the stricter project", () => {
            test("then it should refuse the copy before any browser opens", async () => {
                const cleared = await clearedUnderLooser();
                const copied = { ...cleared, project: parsedProject(STRICTER) } as ClearedRun;
                const { ran, opens } = runOn(copied);
                await assert.rejects(ran, {
                    name: "TypeError",
                    message: "refused a run that the policy gate did not clear",
                });
                assert.equal(opens(), 0);
            });
        });

        describe("when the cleared run itself runs", () => {
            test("then it should open the browser", async () => {
                const { ran, opens } = runOn(await clearedUnderLooser());
                await ran;
                assert.equal(opens(), 1);
            });
        });
    });
});
