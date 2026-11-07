import type { PolicyRuleId } from "../policy.ts";
import type { TerminalState } from "./TerminalState.ts";

// A parsed plan the policy gate's static check denied, so no run started. `unrecorded` is present
// when the audit sink failed to record the denial.
export type DeniedPlan = {
    readonly state: typeof TerminalState.Denied;
    readonly rule: PolicyRuleId;
    readonly stepIndex: number | null;
    readonly unrecorded?: true;
};
