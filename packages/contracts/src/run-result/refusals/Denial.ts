import type { PolicyRuleId } from "../../ports/PolicyRuleId.ts";

// Which policy rule stopped the run, and at which step. `unrecorded` is present when the audit sink
// failed to record the denial, so the result differs from one whose denial was recorded.
export type Denial = {
    readonly rule: PolicyRuleId;
    readonly stepIndex: number;
    readonly unrecorded?: true;
};
