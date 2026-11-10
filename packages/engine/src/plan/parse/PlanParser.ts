// The plan parser: the only way to obtain a Plan. It rejects unknown fields and steps at any
// depth, origins off the allow-list, targets off the matrix, undeclared secrets and fixtures,
// script-like text, vacuous checks and oversized or too deeply nested input, before any side
// effect. Literal secrets are refused: a fill of literal text into a sensitive field, and
// credential-shaped text anywhere. A plan it accepts is frozen and remembered, so a run can tell
// it from a look-alike.
// Calls name a declaration of the trusted project, with arguments typed by it; nothing a plan
// writes can name a URL, a method, a header or a body. Stubs, request checks and storage entries
// likewise: a plan names a declaration and gives typed arguments, never a response, a matcher, a
// storage key or a value to store.
// The unsafe features (css and XPath locators, DOM checks, page scripts and database commands) are
// read only once the trusted project enables each one; a disabled one is refused with
// unsafe_feature_disabled at the field that names it, every use of it, with nothing under it read.
import { success, type Plan, type PlanData, type PlanError, type Result } from "@revisum/contracts";
import { brand } from "../../foundation/Brand.ts";
import type { Project } from "../../project/ParseProject.ts";
import { planRulesOf } from "./ParseContext.ts";
import { readPlanData } from "./ReadPlanData.ts";

// Every plan this parser made, so that assertBranded can tell a parsed plan from a copy or a
// cast. A WeakSet holds no plan alive and cannot be listed or added to from outside this module.
const PARSED_PLANS = new WeakSet<object>();

function deepFreeze<Value>(value: Value): Value {
    if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value)) {
            deepFreeze(child);
        }
    }
    return value;
}

// Builds the parser for one trusted project: a project read by the project parser, or the trusted
// project read from the protected branch.
export function planParser(
    project: Project,
): (input: unknown) => Result<Plan, readonly PlanError[]> {
    const rules = planRulesOf(project);
    return function parsePlan(input) {
        const read = readPlanData(input, rules);
        if (!read.ok) {
            return read;
        }
        // Frozen, so a parsed plan cannot be changed into something the parser never saw.
        const plan = deepFreeze(brand<PlanData, "Plan">(read.value));
        PARSED_PLANS.add(plan);
        return success(plan);
    };
}

// The run-time half of the brand: the type system stops a forged Plan at compile time, but a cast
// defeats it. A run calls this first, so an object the parser did not make is refused before any
// side effect.
export function assertBranded(plan: unknown): asserts plan is Plan {
    if (typeof plan !== "object" || plan === null || !PARSED_PLANS.has(plan)) {
        throw new TypeError("refused a plan that the plan parser did not make");
    }
}
