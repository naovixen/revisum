// A branded value made without a plain cast: annotating what JSON.parse returns, which needs no cast
// at all, or casting to a union or a wrapper that holds the brand. The same shapes with an unbranded
// type pass, and so does writing those types where no value is being made.
import { after, before, describe, test } from "node:test";
import { RepositoryRuleName } from "../../../../tools/repo-rules/RunRepositoryRules.ts";
import { assertLintFails, assertLintPasses } from "../support/WithEdits.ts";
import { copyRepository, type ScratchRepository } from "../support/ScratchRepository.ts";

const TIMEOUT = 300_000;
const ONLY_THE_RULE = { rule: RepositoryRuleName.BrandedCasts };
const PLANTED_FILE = "planted-plan-shortcut.ts";
const PLANTED_MODULE = `packages/cli/src/${PLANTED_FILE}`;
const OWNING_PARSER = "packages/engine/src/plan/parse/PlanParser.ts";

type PlantedSource = { readonly how: string; readonly source: string };

const planModule = (...lines: readonly string[]): string =>
    ["import type { Plan, PlanData } from '@revisum/contracts';", ...lines, ""].join("\n");

const WAYS_TO_MAKE_A_PLAN: readonly PlantedSource[] = [
    {
        how: "annotates what JSON.parse returns as Plan, with no cast",
        source: planModule(
            "export function loadPlan(text: string) {",
            "  const plan: Plan = JSON.parse(text);",
            "  return plan;",
            "}",
        ),
    },
    {
        how: "casts to a union with Plan last",
        source: planModule(
            "export const loadPlan = (text: string) => JSON.parse(text) as undefined | Plan;",
        ),
    },
    {
        how: "casts to Readonly<Plan>",
        source: planModule(
            "export const loadPlan = (text: string) => JSON.parse(text) as Readonly<Plan>;",
        ),
    },
    {
        how: "casts to Array<Plan>",
        source: planModule(
            "export const loadPlans = (text: string) => JSON.parse(text) as Array<Plan>;",
        ),
    },
    {
        how: "annotates what JSON.parse returns as another branded type",
        source: [
            "import type { SafeText } from '@revisum/contracts';",
            "export function loadHeading(text: string) {",
            "  const heading: SafeText = JSON.parse(text);",
            "  return heading;",
            "}",
            "",
        ].join("\n"),
    },
];

const SAME_SHAPES_THAT_MAKE_NO_BRANDED_VALUE: readonly PlantedSource[] = [
    {
        how: "annotates what its parser returns as Plan",
        source: planModule(
            "declare function parseCheckedPlan(text: string): Plan;",
            "export function loadPlan(text: string) {",
            "  const plan: Plan = parseCheckedPlan(text);",
            "  return plan;",
            "}",
        ),
    },
    {
        how: "annotates what JSON.parse returns as unknown",
        source: planModule(
            "export type Unused = Plan | PlanData;",
            "export function readPlan(text: string) {",
            "  const plan: unknown = JSON.parse(text);",
            "  return plan;",
            "}",
        ),
    },
    {
        how: "annotates what JSON.parse returns as the unbranded PlanData",
        source: planModule(
            "export type Unused = Plan;",
            "export function readDraft(text: string) {",
            "  const draft: PlanData = JSON.parse(text);",
            "  return draft;",
            "}",
        ),
    },
    {
        how: "casts to a union and to wrappers of the unbranded PlanData",
        source: planModule(
            "export type Unused = Plan;",
            "export const maybeDraft = (text: string) => JSON.parse(text) as undefined | PlanData;",
            "export const frozenDraft = (text: string) => JSON.parse(text) as Readonly<PlanData>;",
            "export const drafts = (text: string) => JSON.parse(text) as Array<PlanData>;",
        ),
    },
    {
        how: "takes parameters typed as a union and as wrappers of Plan",
        source: planModule(
            "export type Unused = PlanData;",
            "export const stepCount = (plan: undefined | Plan, frozen: Readonly<Plan>, plans: Array<Plan>): number =>",
            "  (plan?.steps.length ?? 0) + frozen.steps.length + plans.length;",
        ),
    },
];

describe("Using the branded-type lint", () => {
    let scratch: ScratchRepository;
    before(() => {
        scratch = copyRepository();
    });
    after(() => {
        scratch.dispose();
    });

    describe("given a module that does not own the Plan brand", () => {
        for (const { how, source } of WAYS_TO_MAKE_A_PLAN) {
            describe(`when it ${how}`, () => {
                test("then it should fail, naming the module", { timeout: TIMEOUT }, () => {
                    assertLintFails(scratch.lintWith(PLANTED_MODULE, source, ONLY_THE_RULE), [
                        "branded-type check: ",
                        PLANTED_FILE,
                    ]);
                });
            });
        }

        for (const { how, source } of SAME_SHAPES_THAT_MAKE_NO_BRANDED_VALUE) {
            describe(`when it ${how}`, () => {
                test("then it should pass", { timeout: TIMEOUT }, () => {
                    assertLintPasses(scratch.lintWith(PLANTED_MODULE, source, ONLY_THE_RULE));
                });
            });
        }
    });

    describe("given the module that owns the Plan brand", () => {
        describe("when it casts to wrappers of Plan", () => {
            test("then it should pass", { timeout: TIMEOUT }, () => {
                const outcome = scratch.lintWithEdit(
                    OWNING_PARSER,
                    (text) =>
                        [
                            text.trimEnd(),
                            "",
                            "export const frozenPlan = (value: unknown) => value as Readonly<Plan>;",
                            "export const plans = (value: unknown) => value as Array<Plan>;",
                            "",
                        ].join("\n"),
                    ONLY_THE_RULE,
                );
                assertLintPasses(outcome);
            });
        });
    });
});
