// The way into the run: a service handed the run's ports once, which runs cleared plans and
// untrusted input with them.
import type { PlanRunResult } from "@revisum/contracts";
import type { ClearedRun } from "../policy/ClearedRun.ts";
import type { RunInputs, RunPorts } from "./RunContext.ts";
import { runPlan } from "./RunPlan.ts";
import {
    runUntrusted,
    type ParsePlan,
    type UntrustedRunInputs,
    type UntrustedRunOutcome,
} from "./RunUntrusted.ts";

export interface RunService {
    // Runs one plan the policy gate cleared for one target.
    run(cleared: ClearedRun, inputs: RunInputs): Promise<PlanRunResult>;
    // Parses untrusted input, has the policy gate judge it, and runs it on each target it clears.
    runUntrusted(
        input: unknown,
        parsePlan: ParsePlan,
        inputs: UntrustedRunInputs,
    ): Promise<UntrustedRunOutcome>;
}

export function createRunService(ports: RunPorts): RunService {
    return {
        run(cleared, inputs) {
            return runPlan(cleared, inputs, ports);
        },
        runUntrusted(input, parsePlan, inputs) {
            return runUntrusted(input, parsePlan, inputs, ports);
        },
    };
}
