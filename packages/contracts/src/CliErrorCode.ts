import { TrustErrorCode } from "./approval.ts";
import { BuildFetchFailureCode } from "./browser-driver.ts";
import { ExploreErrorCode } from "./explore-mode.ts";

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
