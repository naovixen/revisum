// Plans that use no unsafe features keep their recorded hashes. Every golden plan parses to the
// recorded plan, byte for byte, and a run of such a plan gives the recorded result hash and manifest
// hash. test/golden/closed-language/hashes.json holds the plan hash of each golden plan, parsed against
// the shared test project, and the result and manifest hashes of four runs on the recording driver
// (run-value-examples.ts); `npm run goldens:record` remakes it, and a commit changing it must name
// a defect. The golden report replay (test/replay/GoldenReport.test.ts) covers the report and its
// replay hashes.
//
// A change that makes such a plan's result or manifest carry an unsafe field, even an empty list,
// changes these hashes, so the unsafe fields must be absent from those runs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { planHash } from "@revisum/engine";
import { RECORDED_RUNS } from "../../../../support/ClosedLanguageGolden.ts";
import { GOLDEN } from "../../../../support/repository/RepositoryRoot.ts";
import { defaultParser, goldenPlan, goldenPlanNames } from "../examples/GoldenPlan.ts";
import {
    OPEN_ORDERS,
    planOf,
    runPlan,
    type JsonRecord,
} from "../../run/values/examples/RunPlan.ts";

type RecordedRun = {
    readonly state: string;
    readonly resultHash: string;
    readonly manifestHash: string | null;
};
type RecordedHashes = {
    readonly plans: Readonly<Record<string, string>>;
    readonly runs: Readonly<Record<string, RecordedRun>>;
};

const recorded = (): RecordedHashes =>
    JSON.parse(readFileSync(join(GOLDEN, "closed-language", "hashes.json"), "utf8"));

const parsePlan = defaultParser();

test("a plan hash is recorded for every golden plan, and only for those", () => {
    const names = goldenPlanNames();
    assert.ok(names.length >= 20, `only ${names.length} golden plans`);
    assert.deepEqual(Object.keys(recorded().plans).sort(), [...names]);
});

for (const name of goldenPlanNames()) {
    test(`the golden plan "${name}" parses to exactly the recorded plan, by plan hash`, () => {
        const parsed = parsePlan(goldenPlan(name));
        assert.ok(parsed.ok, JSON.stringify(parsed));
        assert.equal(planHash(parsed.value), recorded().plans[name]);
    });
}

test("every golden plan keeps the current version once parsed", () => {
    for (const name of goldenPlanNames()) {
        const declared = goldenPlan(name)["version"];
        const parsed = parsePlan(goldenPlan(name));
        assert.ok(parsed.ok, name);
        assert.equal(parsed.value.version, declared, name);
    }
});

test("a run hash is recorded for every run below", () => {
    assert.deepEqual(Object.keys(recorded().runs).sort(), Object.keys(RECORDED_RUNS).sort());
});

for (const [name, plan] of Object.entries(RECORDED_RUNS)) {
    test(`a run of "${name}" gives the recorded state, result hash and manifest hash`, async () => {
        const { result } = await runPlan(plan());
        assert.deepEqual(
            {
                state: result.state,
                resultHash: result.resultHash,
                manifestHash: result.manifestHash,
            },
            recorded().runs[name],
        );
    });
}

// Counter-example: the recorded hashes are sensitive to a one-byte change, so equal hashes above
// mean equal plans and runs.
test("a one-character change to a golden plan's title changes its plan hash, and another seed changes a run's hashes", async () => {
    const changed = {
        ...goldenPlan("signup"),
        meta: { ...(goldenPlan("signup")["meta"] as JsonRecord), title: "Sign-up happy path!" },
    };
    const parsed = parsePlan(changed);
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.notEqual(planHash(parsed.value), recorded().plans["signup"]);
    const { result } = await runPlan(planOf([OPEN_ORDERS]), { seed: 8 });
    assert.notEqual(result.resultHash, recorded().runs["open-orders"]?.resultHash);
});

test("a closed run's result and manifest hold no unsafe field at all, not even an empty one", async () => {
    for (const [name, plan] of Object.entries(RECORDED_RUNS)) {
        const { result } = await runPlan(plan());
        assert.equal(Object.hasOwn(result, "unsafeFeatures"), false, name);
        if (result.manifest === null) {
            continue;
        }
        assert.equal(Object.hasOwn(result.manifest, "unsafeFeatures"), false, name);
        assert.equal(Object.hasOwn(result.manifest, "unsafeDeclarations"), false, name);
    }
});
