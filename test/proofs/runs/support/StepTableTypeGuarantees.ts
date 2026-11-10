// Compile-time guarantees of the step tables. Type-checked by type-check.test.ts, never run.
//   - The policy rule and executor lookups take only the step and pair it with its own type
//     inside, so a caller cannot hand a step to another type's entry, nor pair a type and a step
//     that were never checked to agree.
//   - Each step fact's fields name only the fields its own step type has, those of every variant
//     included, so a field name no step of that type has does not compile.
//   - A verdict that passes carries no failure code, and one that fails always carries its code.
// The lookups and the facts are the engine's own, not its public API, so they are imported from
// its sources. Each @ts-expect-error line must stay an error: tsc reports one that compiles.
import type { Step, StepByType, StepType } from "@revisum/contracts";
import type { Verdict } from "@revisum/engine";
import {
    STEP_FACTS,
    type FieldOf,
    type StepFact,
} from "../../../../packages/engine/src/plan/StepFacts.ts";
import {
    STEP_RULES,
    callRuleBeforeRun,
    ruleBeforeRun,
    ruleDuringRun,
    type GuardedAction,
    type StaticContext,
} from "../../../../packages/engine/src/policy/StepRules.ts";
import type { RunStep, RunStepByType } from "../../../../packages/engine/src/run/steps/RunStep.ts";
import type { StepContext } from "../../../../packages/engine/src/run/executors/StepExecutor.ts";
import {
    STEP_EXECUTORS,
    executeStep,
} from "../../../../packages/engine/src/run/executors/StepExecutors.ts";

declare const staticContext: StaticContext;
declare const action: GuardedAction;
declare const stepContext: StepContext;
declare const anyType: StepType;
declare const anyStep: Step;
declare const anyRunStep: RunStep;
declare const clickStep: StepByType["click"];
declare const clickRunStep: RunStepByType["click"];

// ---- The rule and executor lookups --------------------------------------------------------------

// What each lookup is handed, each of which type-checks.
export const stepTableTypeGuarantees = {
    ruleForAnyStep: ruleBeforeRun(anyStep, staticContext),
    callRuleForAnyStep: callRuleBeforeRun(anyStep, staticContext),
    guardForAnyStep: ruleDuringRun(anyStep, action),
    executedAnyStep: executeStep(anyRunStep, stepContext),
    clickRuleForItsOwnStep: STEP_RULES.click.beforeRun(clickStep, staticContext),
};

// @ts-expect-error a lookup takes no separate type, so none can be paired with another type's step
export const ruleWithSeparateType = ruleBeforeRun("navigate", clickStep, staticContext);

// @ts-expect-error a guard lookup takes no separate type either
export const guardWithSeparateType = ruleDuringRun("navigate", clickStep, action);

// @ts-expect-error an executor lookup takes no separate type either
export const executedWithSeparateType = executeStep("navigate", clickRunStep, stepContext);

// @ts-expect-error a click step handed to the navigate rule does not compile
export const clickJudgedAsNavigate = STEP_RULES.navigate.beforeRun(clickStep, staticContext);

// @ts-expect-error a click step handed to the navigate executor does not compile
export const clickRunAsNavigate = STEP_EXECUTORS.navigate(clickRunStep, stepContext);

// @ts-expect-error a type and a step never checked to agree cannot reach a rule
export const uncheckedPairJudged = STEP_RULES[anyType].beforeRun(anyStep, staticContext);

// @ts-expect-error a type and a step never checked to agree cannot reach an executor
export const uncheckedPairRun = STEP_EXECUTORS[anyType](anyRunStep, stepContext);

// ---- Step facts ---------------------------------------------------------------------------------

// A navigate fact names navigate's fields, and a stub's start has arguments that its stop does not:
// a variant's field is still the type's.
export const factsNameTheirOwnFields: {
    readonly navigate: StepFact<FieldOf<"navigate">>;
    readonly stubArguments: FieldOf<"stub">;
} = {
    navigate: STEP_FACTS.navigate,
    stubArguments: "arguments",
};

export const navigateRequiringLocator: StepFact<FieldOf<"navigate">> = {
    ...STEP_FACTS.navigate,
    // @ts-expect-error a navigate fact cannot require a field only other steps have
    fields: { required: ["type", "locator"], optional: [] },
};

export const navigateAllowingSteps: StepFact<FieldOf<"navigate">> = {
    ...STEP_FACTS.navigate,
    // @ts-expect-error a navigate fact cannot allow a field only other steps have
    fields: { required: ["type", "url"], optional: ["steps"] },
};

export const tableWithMisnamedField: typeof STEP_FACTS = {
    ...STEP_FACTS,
    // @ts-expect-error the facts table cannot give a step type a field no step of it has
    navigate: { ...STEP_FACTS.navigate, fields: { required: ["type", "href"], optional: [] } },
};

// A step type states whether it may change the page, so a new type can't leave that out.
export const everyFactStatesWhetherItChangesThePage: {
    readonly [Type in StepType]: { readonly changesPage: boolean };
} = STEP_FACTS;

// @ts-expect-error a fact that does not state whether its step changes the page does not compile
export const factWithoutChangesPage: StepFact = {
    section: STEP_FACTS.click.section,
    fields: STEP_FACTS.click.fields,
    isAssertion: STEP_FACTS.click.isAssertion,
    placement: STEP_FACTS.click.placement,
    isSetup: STEP_FACTS.click.isSetup,
    holdsSteps: STEP_FACTS.click.holdsSteps,
    frameDepthAdded: STEP_FACTS.click.frameDepthAdded,
    opensUrl: STEP_FACTS.click.opensUrl,
};

// A step type states whether it is unsafe in the table, so a new type can't leave that to a separate
// list. The column's own name is the table's to choose, as long as it says "unsafe" and is required.
type UnsafeStatusColumn = Extract<keyof StepFact, `${string}${"unsafe" | "Unsafe"}${string}`>;
export const isUnsafeStatusARequiredColumn: Record<never, never> extends Pick<
    StepFact,
    UnsafeStatusColumn
>
    ? false
    : true = true;

// ---- Verdicts -----------------------------------------------------------------------------------

export const verdictsThatCompile: readonly Verdict[] = [
    { pass: true },
    { pass: false, code: "not-found" },
];

// @ts-expect-error a failing verdict without its code does not compile
export const failedWithoutCode: Verdict = { pass: false };

// @ts-expect-error a failing verdict's code is never empty
export const failedWithNullCode: Verdict = { pass: false, code: null };

// @ts-expect-error a passing verdict carries no failure code
export const passedWithCode: Verdict = { pass: true, code: "not-found" };
