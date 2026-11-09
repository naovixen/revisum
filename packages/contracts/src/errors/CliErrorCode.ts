import { TrustErrorCode } from "../ports/Approval.ts";
import { BuildFetchFailureCode } from "../ports/BrowserDriver.ts";
import { ExploreErrorCode } from "../modes/PageMap.ts";

// Why a command-line invocation failed. Each maps to one exit status.
export const CliErrorCode = {
    Usage: "usage",
    ConfigInvalid: "config-invalid",
    UntrustedSource: TrustErrorCode.UntrustedSource,
    PlanRejected: "plan-rejected",
    TargetUnavailable: "target-unavailable",
    ...BuildFetchFailureCode,
    ApprovalRefused: "approval-refused",
    ReplayMismatch: "replay-mismatch",
    Internal: "internal",
    // The draft command's planner and its explore mode.
    ...ExploreErrorCode,
} as const;
export type CliErrorCode = (typeof CliErrorCode)[keyof typeof CliErrorCode];
