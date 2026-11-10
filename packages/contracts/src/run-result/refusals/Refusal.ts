import type { SecretName } from "../../plan/SecretName.ts";

// Why a run was refused before any driver call.
//   origin-not-allowed: the run would reach one of the project's production origins, which only an
//     approved plan may reach, and only when the project allows production for approved plans.
//   secret-missing: the plan names a secret, or makes a call that needs one, that the secret store
//     cannot resolve. The refusal names the secret, never a value.
//   services-unavailable: the plan calls a declared service, but the run was given no service caller.
//   storage-state-unsupported: the plan names saved storage state, which no driver can load yet.
//   element-check-unsupported: the plan checks that an element is checked, unchecked or focused, which
//     no driver's probe can decide, so no earlier step may act for a check that was always going to fail.
//   database-commands-unavailable: the plan runs a database command, in its steps or its cleanup, but
//     the run was given no command runner.
//   script-source-missing: the plan names a page script whose source the run was not given, so the
//     manifest could not record what would run.
// And why an evidence run (`run --suite`) was refused before any container started:
//   evidence-mode-disabled: the trusted project has no evidenceMode section.
//   suite-not-declared: the evidenceMode section declares no suite of that name.
//   egress-unenforceable: egress cannot be enforced on this host, and suite code never runs without it.
//   image-missing, image-digest-mismatch: the suite's workload image is not here, or not the pinned one.
//   workload-start-failed: the workload container did not start, so no suite code ran.
// A suite whose declared secret the store cannot resolve is refused with secret-missing, as a plan is.
export const RefusalCode = {
    OriginNotAllowed: "origin-not-allowed",
    SecretMissing: "secret-missing",
    ServicesUnavailable: "services-unavailable",
    StorageStateUnsupported: "storage-state-unsupported",
    DatabaseCommandsUnavailable: "database-commands-unavailable",
    EvidenceModeDisabled: "evidence-mode-disabled",
    SuiteNotDeclared: "suite-not-declared",
    EgressUnenforceable: "egress-unenforceable",
    ScriptSourceMissing: "script-source-missing",
    ImageMissing: "image-missing",
    ImageDigestMismatch: "image-digest-mismatch",
    WorkloadStartFailed: "workload-start-failed",
    ElementCheckUnsupported: "element-check-unsupported",
} as const;

export type RefusalCode = (typeof RefusalCode)[keyof typeof RefusalCode];

export type SecretMissingRefusal = {
    readonly code: typeof RefusalCode.SecretMissing;
    readonly secretName: SecretName;
};

// Why a plan run was refused.
export type PlanRefusal =
    | { readonly code: typeof RefusalCode.OriginNotAllowed; readonly origin: string }
    | SecretMissingRefusal
    | {
          readonly code:
              | typeof RefusalCode.ServicesUnavailable
              | typeof RefusalCode.StorageStateUnsupported
              | typeof RefusalCode.DatabaseCommandsUnavailable
              | typeof RefusalCode.ElementCheckUnsupported;
      }
    // The plan names a page script whose source file the run was not given, by its declared path.
    | { readonly code: typeof RefusalCode.ScriptSourceMissing; readonly file: string };

// Why an evidence run's suite was refused, apart from a secret it declares that the store lacks.
export type EvidenceRefusal = {
    readonly code:
        | typeof RefusalCode.EvidenceModeDisabled
        | typeof RefusalCode.SuiteNotDeclared
        | typeof RefusalCode.EgressUnenforceable
        | typeof RefusalCode.ImageMissing
        | typeof RefusalCode.ImageDigestMismatch
        | typeof RefusalCode.WorkloadStartFailed;
};

// Why an evidence run was refused.
export type SuiteRefusal = EvidenceRefusal | SecretMissingRefusal;

export type Refusal = PlanRefusal | SuiteRefusal;
