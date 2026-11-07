// The ports a run is given when its caller has nothing to wire to them. Each does what a run did
// when the port was left out: a plan that needs services or database commands is refused before any
// side effect, every secret the plan names is missing, and no response was rewritten.
import {
    failure,
    ServiceCallErrorCode,
    WorkloadErrorCode,
    type AppliedRewrite,
    type DatabaseCommandRunner,
    type SecretStore,
    type ServiceCaller,
} from "@revisum/contracts";
import type { RunPorts } from "./RunContext.ts";

export const emptySecretStore: SecretStore = { resolve: () => null };

// Preflight knows this caller by identity and refuses a plan that calls a service. A plan that calls
// none never uses it, and a call through it would fail as unreachable.
export const noServiceCaller: ServiceCaller = {
    call: () => Promise.resolve(failure(ServiceCallErrorCode.ServiceUnreachable)),
};

// Preflight knows this runner by identity and refuses a plan with a database command. A plan with
// none never uses it, and a command through it would fail to start.
export const noDatabaseCommandRunner: DatabaseCommandRunner = {
    run: () => Promise.resolve(failure(WorkloadErrorCode.WorkloadStartFailed)),
};

export const noRewrites = (): readonly AppliedRewrite[] => [];

export const unwiredPorts: Pick<
    RunPorts,
    "secrets" | "services" | "databaseCommands" | "rewritesApplied"
> = {
    secrets: emptySecretStore,
    services: noServiceCaller,
    databaseCommands: noDatabaseCommandRunner,
    rewritesApplied: noRewrites,
};
