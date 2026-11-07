// The only entry point for untrusted input, such as a plan an AI proposed.
import { UnavailableReason, type Plan, type Result } from "@revisum/contracts";
import type { PlanStanding } from "../approval/plan-standing.ts";
import type { PlanError } from "../plan/plan-decoders.ts";
import { ClearedRunKind } from "../policy/ClearedRun.ts";
import { policyGate } from "../policy/policy-gate.ts";
import type { Project } from "../project/project-parser.ts";
import type { RunInputs, RunPorts } from "./RunContext.ts";
import { runPlan } from "./RunPlan.ts";
import type { DeniedPlan, Rejected, RunResult } from "./RunResult.ts";
import { targetNotDeclaredResult } from "./seal/TargetNotDeclaredResult.ts";

export type ParsePlan = (input: unknown) => Result<Plan, readonly PlanError[]>;

// How an untrusted plan is to be run: as a cleared run is, under the project and standing it is
// judged by.
export type UntrustedRunInputs = RunInputs & {
    readonly project: Project;
    readonly standing?: PlanStanding;
};

export const UntrustedRunOutcomeKind = {
    Rejected: "rejected",
    Denied: "denied",
    Ran: "ran",
} as const;

export type UntrustedRunOutcomeKind =
    (typeof UntrustedRunOutcomeKind)[keyof typeof UntrustedRunOutcomeKind];

// The plan the parser rejected, the plan the policy gate denied, or one result per target it names.
export type UntrustedRunOutcome =
    | ({ readonly kind: typeof UntrustedRunOutcomeKind.Rejected } & Rejected)
    | ({ readonly kind: typeof UntrustedRunOutcomeKind.Denied } & DeniedPlan)
    | { readonly kind: typeof UntrustedRunOutcomeKind.Ran; readonly results: readonly RunResult[] };

// Parsing happens first, then the policy gate's static check against the project, for the plan's
// declared targets and standing; on any error or denial no driver method is called. A missing
// standing, or one whose approval is for another plan's hash, is a proposal: it never reaches the
// project's production origins.
export async function runUntrusted(
    input: unknown,
    parsePlan: ParsePlan,
    base: UntrustedRunInputs,
    ports: RunPorts,
): Promise<UntrustedRunOutcome> {
    const parsed = parsePlan(input);
    if (!parsed.ok) {
        return { kind: UntrustedRunOutcomeKind.Rejected, state: "Rejected", errors: parsed.error };
    }
    const { project, standing, ...inputs } = base;
    const gate = policyGate({ project, events: ports.audit });
    // One result per target the plan names, in its order: one the matrix does not declare ends
    // TargetUnavailable with not-declared.
    const decision = gate.decide(parsed.value, parsed.value.targets, standing);
    if (decision.kind === "deny") {
        return {
            kind: UntrustedRunOutcomeKind.Denied,
            state: "Denied",
            rule: decision.rule,
            stepIndex: decision.stepIndex,
            ...(decision.unrecorded ? { unrecorded: true } : {}),
        };
    }
    const results: RunResult[] = [];
    for (const clearance of decision.runs) {
        switch (clearance.kind) {
            case ClearedRunKind:
                results.push(await runPlan(clearance, inputs, ports));
                break;
            case UnavailableReason.NotDeclared:
                results.push(targetNotDeclaredResult(clearance, inputs.seed, ports));
                break;
            // A new kind of clearance fails to compile here until it is handled.
            default: {
                const unhandled: never = clearance;
                return unhandled;
            }
        }
    }
    return { kind: UntrustedRunOutcomeKind.Ran, results };
}
