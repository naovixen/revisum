// What test/golden/closed-language/hashes.json holds, computed the way its test computes it: the plan
// hash of each golden plan, and the state and hashes of a few runs on the recording driver.
// tools/test-runner/RecordGoldens.ts runs this file and writes what it prints.
import { planHash } from "@revisum/engine";
import { defaultParser, goldenPlan, goldenPlanNames } from "../unit/engine/plan/examples/GoldenPlan.ts";
import {
    OPEN_ORDERS,
    planOf,
    runPlan,
    type JsonRecord,
} from "../unit/engine/run/values/examples/RunPlan.ts";

export const RECORDED_RUNS: Readonly<Record<string, () => JsonRecord>> = {
    "open-orders": () => planOf([OPEN_ORDERS]),
    signup: () => goldenPlan("signup"),
    "order-page-by-path": () => goldenPlan("order-page-by-path"),
    "order-backend-state": () => goldenPlan("order-backend-state"),
};

function recordedPlanHash(name: string, parse: ReturnType<typeof defaultParser>): string {
    const parsed = parse(goldenPlan(name));
    if (!parsed.ok) {
        throw new Error(`the golden plan ${name} was rejected: ${JSON.stringify(parsed.error)}`);
    }
    return planHash(parsed.value);
}

async function recordedRun(plan: () => JsonRecord): Promise<Readonly<Record<string, unknown>>> {
    const { result } = await runPlan(plan());
    return {
        state: result.state,
        resultHash: result.resultHash,
        manifestHash: result.manifestHash,
    };
}

export async function closedLanguageGolden(): Promise<Readonly<Record<string, unknown>>> {
    const parse = defaultParser();
    const plans = new Map<string, string>();
    for (const name of goldenPlanNames()) {
        plans.set(name, recordedPlanHash(name, parse));
    }
    const runs = new Map<string, unknown>();
    for (const [name, plan] of Object.entries(RECORDED_RUNS)) {
        runs.set(name, await recordedRun(plan));
    }
    return {
        "closed-language/hashes.json": {
            plans: Object.fromEntries(plans),
            runs: Object.fromEntries(runs),
        },
    };
}

if (import.meta.main) {
    process.stdout.write(JSON.stringify(await closedLanguageGolden()));
}
