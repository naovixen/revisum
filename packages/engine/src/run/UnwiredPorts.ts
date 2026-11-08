// The ports a run is given when its caller has nothing to wire to them. Each does what a run did
// when the port was left out: a plan that needs services or database commands is refused before any
// side effect, every secret the plan names is missing, and no response was rewritten.
import {
    failure,
    isWiredPort,
    ServiceCallErrorCode,
    UNWIRED_PORT,
    WorkloadErrorCode,
    type AppliedRewrite,
    type DatabaseCommandRunner,
    type SecretStore,
    type ServiceCaller,
    type UnwiredPort,
} from "@revisum/contracts";
import type { RunPorts } from "./RunContext.ts";

export const emptySecretStore: SecretStore = { resolve: () => null };

// Preflight refuses a plan that calls a service when its caller is unwired.
export const noServiceCaller: UnwiredPort = UNWIRED_PORT;

// Preflight refuses a plan with a database command when its runner is unwired.
export const noDatabaseCommandRunner: UnwiredPort = UNWIRED_PORT;

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

// What a plan that passed preflight runs with in place of an unwired port. It calls neither, since a
// plan that does was refused, and a call through one would fail as unreachable or unstarted.
const serviceCallerNeverCalled: ServiceCaller = {
    call: () => Promise.resolve(failure(ServiceCallErrorCode.ServiceUnreachable)),
};
const databaseCommandRunnerNeverCalled: DatabaseCommandRunner = {
    run: () => Promise.resolve(failure(WorkloadErrorCode.WorkloadStartFailed)),
};

export const serviceCallerOf = (port: ServiceCaller | UnwiredPort): ServiceCaller =>
    isWiredPort(port) ? port : serviceCallerNeverCalled;

export const databaseCommandRunnerOf = (
    port: DatabaseCommandRunner | UnwiredPort,
): DatabaseCommandRunner => (isWiredPort(port) ? port : databaseCommandRunnerNeverCalled);
