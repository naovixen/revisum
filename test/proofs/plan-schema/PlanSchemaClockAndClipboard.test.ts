// Advancing the clock and checking the clipboard join the plan language's published schema.
// test/golden/plans/ holds a golden plan for each new step and source, `npm run lint` validates
// every golden plan against the schema, and the changelog's one 1.2 entry names each new step,
// mode, unit, check, source, limit and error code. The schema-hash and entry-format checks are
// in plan-schema-newer-version.test.ts.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { parseProject, planParser } from "@revisum/engine";
import { testProjectInput } from "../../unit/engine/plan/examples/GoldenPlan.ts";
import { changelogEntry } from "../../support/repository/ChangelogEntries.ts";
import { GOLDEN, REPOSITORY_ROOT } from "../../support/repository/RepositoryRoot.ts";
import { RepositoryRuleName } from "../../../tools/repo-rules/RunRepositoryRules.ts";
import {
    copyRepository,
    type LintOutcome,
    type ScratchRepository,
} from "../repo-rules/support/ScratchRepository.ts";

const CLOCK_PLAN_PATH = "test/golden/plans/session-expiry-clock.json";
const CLIPBOARD_PLAN_PATH = "test/golden/plans/copied-invite-link.json";
const REMEMBER_PLAN_PATH = "test/golden/plans/remembered-copied-link.json";
const TIMEOUT = 300_000;

type JsonRecord = Record<string, unknown>;

const readText = (relativePath: string): string =>
    readFileSync(join(REPOSITORY_ROOT, relativePath), "utf8");

const goldenPlans = (): JsonRecord[] =>
    readdirSync(join(GOLDEN, "plans"))
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map((name): JsonRecord => JSON.parse(readFileSync(join(GOLDEN, "plans", name), "utf8")));

// Every object inside a JSON value, depth first.
const objectsIn = (value: unknown): JsonRecord[] => {
    if (Array.isArray(value)) {
        return value.flatMap(objectsIn);
    }
    if (typeof value !== "object" || value === null) {
        return [];
    }
    const record: JsonRecord = { ...value };
    return [record, ...Object.values(record).flatMap(objectsIn)];
};

const stepsWhere = (plan: JsonRecord, matches: (step: JsonRecord) => boolean): boolean =>
    objectsIn(plan["steps"]).some(matches);
const isAdvance = (step: JsonRecord): boolean => step["type"] === "advanceClock";
const clipboardCheckKind = (step: JsonRecord): unknown => {
    const assertion = step["assert"];
    return step["type"] === "expectClipboard" &&
        typeof assertion === "object" &&
        assertion !== null &&
        "kind" in assertion
        ? assertion.kind
        : undefined;
};
const remembersClipboard = (step: JsonRecord): boolean => {
    const from = step["from"];
    return (
        step["type"] === "remember" &&
        typeof from === "object" &&
        from !== null &&
        "clipboard" in from &&
        from.clipboard === "text"
    );
};

const FEATURES: Readonly<Record<string, (plan: JsonRecord) => boolean>> = {
    "an advanceClock with no mode": (plan) =>
        stepsWhere(plan, (step) => isAdvance(step) && step["mode"] === undefined),
    "an advanceClock in runTimers mode": (plan) =>
        stepsWhere(plan, (step) => isAdvance(step) && step["mode"] === "runTimers"),
    "an advanceClock in skipAhead mode": (plan) =>
        stepsWhere(plan, (step) => isAdvance(step) && step["mode"] === "skipAhead"),
    ...Object.fromEntries(
        ["textEquals", "textContains", "textExcludes"].map((kind) => [
            `the clipboard check "${kind}"`,
            (plan: JsonRecord) => stepsWhere(plan, (step) => clipboardCheckKind(step) === kind),
        ]),
    ),
    "a clipboard textEquals against several lines": (plan) =>
        stepsWhere(
            plan,
            (step) =>
                clipboardCheckKind(step) === "textEquals" &&
                objectsIn(step["assert"]).some((object) => Array.isArray(object["lines"])),
        ),
    "a remember from the clipboard": (plan) => stepsWhere(plan, remembersClipboard),
};

for (const [feature, uses] of Object.entries(FEATURES)) {
    test(`a golden plan uses ${feature}`, () => {
        assert.ok(goldenPlans().some(uses), `no golden plan uses ${feature}`);
    });
}

test("the clock, clipboard and clipboard-remember golden plans declare the current version and parse against the shared test project", () => {
    const project = parseProject(testProjectInput());
    assert.ok(project.ok, JSON.stringify(project));
    const parse = planParser(project.value);
    for (const path of [CLOCK_PLAN_PATH, CLIPBOARD_PLAN_PATH, REMEMBER_PLAN_PATH]) {
        const plan: JsonRecord = JSON.parse(readText(path));
        assert.equal(plan["version"], "1.3", path);
        const parsed = parse(plan);
        assert.ok(parsed.ok, `${path}: ${JSON.stringify(parsed)}`);
    }
});

// ---- The changelog's 1.2 entry ---------------------------------------------------------------------

const NAMED_IN_ENTRY = [
    "advanceClock",
    "runTimers",
    "skipAhead",
    "milliseconds",
    "seconds",
    "minutes",
    "hours",
    "days",
    "expectClipboard",
    "textExcludes",
    "clipboard",
    "maximumClockAdvanceMilliseconds",
    "maximumTotalClockAdvanceMilliseconds",
    "maximumTimersPerAdvance",
    "maximumClipboardCharacters",
    "clock-runaway",
    "clipboard-unavailable",
];

test("the 1.2 changelog entry names each new step, mode, unit, check, source, limit and error code, in code type", () => {
    const entry = changelogEntry("1.2");
    assert.match(entry, /^## 1\.2\b/);
    assert.deepEqual(
        NAMED_IN_ENTRY.filter((name) => !entry.includes(`\`${name}\``)),
        [],
        "names the 1.2 entry leaves out",
    );
});

// ---- The lint check ---------------------------------------------------------------------------------

const ONLY_THE_RULE = { rule: RepositoryRuleName.PlanSchema };

let scratch: ScratchRepository;
before(() => {
    scratch = copyRepository();
});
after(() => {
    scratch.dispose();
});

function assertFailsNaming(outcome: LintOutcome, fileName: string): void {
    assert.equal(outcome.passed, false, "the lint passed");
    assert.ok(
        outcome.failureOutput.includes(fileName),
        `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`,
    );
}

const planAt = (path: string): JsonRecord => JSON.parse(readText(path));
const stepsOf = (plan: JsonRecord): JsonRecord[] => {
    const steps = plan["steps"];
    assert.ok(Array.isArray(steps));
    return steps;
};
const firstAdvance = (plan: JsonRecord): JsonRecord => {
    const advance = stepsOf(plan).find(isAdvance);
    assert.ok(advance !== undefined);
    return advance;
};

test(
    "the lint fails when a golden plan advances the clock by an unknown unit",
    { timeout: TIMEOUT },
    () => {
        const plan = planAt(CLOCK_PLAN_PATH);
        firstAdvance(plan)["by"] = { amount: 1, unit: "weeks" };
        assertFailsNaming(
            scratch.lintWith(
                "test/golden/plans/planted-clock-unit.json",
                `${JSON.stringify(plan, null, 2)}\n`,
                ONLY_THE_RULE,
            ),
            "planted-clock-unit.json",
        );
    },
);

test("the lint fails when a golden plan gives an advance a real wait", { timeout: TIMEOUT }, () => {
    const plan = planAt(CLOCK_PLAN_PATH);
    firstAdvance(plan)["sleep"] = 1000;
    assertFailsNaming(
        scratch.lintWith(
            "test/golden/plans/planted-clock-sleep.json",
            `${JSON.stringify(plan, null, 2)}\n`,
            ONLY_THE_RULE,
        ),
        "planted-clock-sleep.json",
    );
});

test(
    "the lint fails when a golden plan remembers the clipboard as HTML",
    { timeout: TIMEOUT },
    () => {
        const plan = planAt(REMEMBER_PLAN_PATH);
        const remember = stepsOf(plan).find(remembersClipboard);
        assert.ok(remember !== undefined);
        remember["from"] = { clipboard: "html" };
        assertFailsNaming(
            scratch.lintWith(
                "test/golden/plans/planted-clipboard-html.json",
                `${JSON.stringify(plan, null, 2)}\n`,
                ONLY_THE_RULE,
            ),
            "planted-clipboard-html.json",
        );
    },
);

// Counter-example: a valid copy of the clipboard plan, with an advance added, passes, so the
// failures above come from the planted problems.
test(
    "the lint accepts a new golden plan with an advance and clipboard checks",
    { timeout: TIMEOUT },
    () => {
        const plan = planAt(CLIPBOARD_PLAN_PATH);
        (plan["meta"] as JsonRecord)["title"] = "Copy buttons, second copy";
        stepsOf(plan).splice(4, 0, {
            type: "advanceClock",
            by: { amount: 300, unit: "milliseconds" },
            mode: "runTimers",
        });
        const outcome = scratch.lintWith(
            "test/golden/plans/planted-valid-clipboard.json",
            `${JSON.stringify(plan, null, 2)}\n`,
        );
        assert.equal(outcome.passed, true, outcome.failureOutput);
    },
);
