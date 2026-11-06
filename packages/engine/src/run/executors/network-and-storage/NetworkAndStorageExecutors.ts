// Stubs, request checks and web storage, which the session's network and storage ports carry out.
import {
    checkRequests,
    checkResponse,
    checkStorage,
    resetRequests,
    runStubStep,
    writeStorage,
    type NetworkStepContext,
} from "../../../network-and-storage/network-and-storage-steps.ts";
import { stubAndStorageSecretStore } from "../../../secrets/secret-resolution.ts";
import type { SessionContext, StepExecutorTable } from "../StepExecutor.ts";

// What the stub, request-check and storage steps use: the run's session, values and the secrets
// resolved for stub starts and storage writes.
export const networkContext = (context: SessionContext): NetworkStepContext => ({
    project: context.cleared.project,
    session: context.session,
    values: context.values,
    remembered: context.remembered,
    secrets: stubAndStorageSecretStore(context.secrets),
    clock: context.ports.clock,
    activeStubs: context.activeStubs,
});

export const NETWORK_AND_STORAGE_EXECUTORS: Pick<
    StepExecutorTable,
    | "stub"
    | "resetRequests"
    | "expectRequests"
    | "expectResponse"
    | "setStorage"
    | "removeStorage"
    | "expectStorage"
> = {
    stub: (step, context) => runStubStep(step, networkContext(context)),
    resetRequests: (step, context) => resetRequests(step, networkContext(context)),
    expectRequests: (step, context) => checkRequests(step, networkContext(context)),
    expectResponse: (step, context) => checkResponse(step, networkContext(context)),
    setStorage: (step, context) => writeStorage(step, networkContext(context)),
    removeStorage: (step, context) => writeStorage(step, networkContext(context)),
    expectStorage: (step, context) => checkStorage(step, networkContext(context)),
};
