import { DriverErrorCode } from "../browser-driver.ts";
import { ServiceCallErrorCode } from "../service-calls.ts";
import { WorkloadErrorCode } from "../workload.ts";

// Every code a step's result can hold. A step that passed holds one only to say what it left out.
export const StepCode = {
    ...DriverErrorCode,
    ...ServiceCallErrorCode,
    ...WorkloadErrorCode,

    // The value a step needed could not be used.
    ValueEmpty: "value-empty",
    ValueUnsafe: "value-unsafe",
    ValueTooLong: "value-too-long",
    ValueHoldsSecret: "value-holds-secret",
    SecretMissing: "secret-missing",

    // What the run read back could not be checked.
    StateNotExposed: "state-not-exposed",
    DownloadNotText: "download-not-text",
    RequestNotSeen: "request-not-seen",
    ScriptResultTooLarge: "script-result-too-large",

    // A database step's command.
    CommandFailed: "command-failed",
    CommandTimeout: "command-timeout",
    CommandOutputInvalid: "command-output-invalid",

    // The step's own verdict, or what stopped it.
    AccessibilityViolations: "a11y-violations",
    OriginNotAllowed: "origin-not-allowed",
    AdapterError: "adapter-error",

    // A capture that passed with no image, since a field a secret was typed into could not be masked.
    CaptureLeftOut: "capture-left-out",
} as const;

export type StepCode = (typeof StepCode)[keyof typeof StepCode];
