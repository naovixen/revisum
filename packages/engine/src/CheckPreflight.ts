// Preflight: the checks that refuse a cleared run before any side effect, in one fixed order: a
// production origin the run may not reach, a missing secret, a page script whose source is missing,
// services or database commands the plan needs with nothing to run them, a saved storage state, and
// an element check no driver decides. Each reads only the cleared run and what the run was handed,
// so a refusal leaves nothing behind: no browser opened, no call sent, no command run. A run that
// passes gets what those checks proved, so nothing after them checks again.
//
// What the target itself allows is not here, and ends a run TargetUnavailable rather than Refused:
// a target the plan or the matrix does not declare never becomes a cleared run (the policy gate
// gives it a TargetNotDeclared), and an adapter that is not registered, one whose `supports` says no
// and a browser build other than the pinned one are found as the run opens its session.
import {
    failure,
    isElementCheckNoDriverDecides,
    ServiceCallErrorCode,
    success,
    WorkloadErrorCode,
    type BaseUrl,
    type DatabaseCommandRunner,
    type Result,
    type SecretName,
    type ServiceCaller,
} from "@revisum/contracts";
import type { Refusal } from "./lifecycle.ts";
import { missingScriptSource } from "./manifest.ts";
import { callsServices, runsDatabaseCommands } from "./plan/CallsServices.ts";
import { everyPlanStep } from "./plan/plan-parser.ts";
import type { ClearedRun } from "./policy/ClearedRun.ts";
import { isProductionAllowed } from "./policy/IsProductionAllowed.ts";
import { productionOriginReached } from "./ReachableOrigins.ts";
import type { ResolvedSecrets } from "./secrets/secret-resolution.ts";

export type PreflightFacts = {
    readonly cleared: ClearedRun;
    readonly baseUrl: BaseUrl;
    // The plan's secrets as the store resolved them, or the first name it could not.
    readonly secrets: Result<ResolvedSecrets, SecretName>;
    readonly scriptSources: Readonly<Record<string, Uint8Array>>;
    readonly services: ServiceCaller | undefined;
    readonly databaseCommands: DatabaseCommandRunner | undefined;
};

// What a run that passed preflight runs with. The secrets are every one the plan names, resolved.
// The service caller and command runner are the run's own when the plan needs them; a plan that
// needs neither gets one that is never called, and fails as unreachable if it were.
export type PreflightPassed = {
    readonly secrets: ResolvedSecrets;
    readonly services: ServiceCaller;
    readonly databaseCommands: DatabaseCommandRunner;
};

const NO_SERVICE_CALLER: ServiceCaller = {
    call: () => Promise.resolve(failure(ServiceCallErrorCode.ServiceUnreachable)),
};
const NO_COMMAND_RUNNER: DatabaseCommandRunner = {
    run: () => Promise.resolve(failure(WorkloadErrorCode.WorkloadStartFailed)),
};

type PreflightCheck = (facts: PreflightFacts) => Refusal | undefined;

const refuseProductionOrigin: PreflightCheck = (facts) => {
    const origin = isProductionAllowed(facts.cleared.standing, facts.cleared.project.policy)
        ? undefined
        : productionOriginReached(facts.cleared, facts.baseUrl);
    return origin === undefined ? undefined : { code: "origin-not-allowed", origin };
};

// The manifest could not record what would run.
const refuseMissingScriptSource: PreflightCheck = (facts) => {
    const file = missingScriptSource(
        facts.cleared.plan,
        facts.cleared.project,
        facts.scriptSources,
    );
    return file === undefined ? undefined : { code: "script-source-missing", file };
};

// A plan that needs one of the next four relies on it to mean anything: stopping part way would leave
// test data behind or report on a run that never had what it declared.
const refuseUnwiredServices: PreflightCheck = (facts) =>
    callsServices(facts.cleared.plan) && facts.services === undefined
        ? { code: "services-unavailable" }
        : undefined;

// A plan that names it relies on being signed in. Loading it comes with the driver's session
// environment; until then no run can honour it, so the plan parses and every run of it is refused.
const refuseStorageState: PreflightCheck = (facts) =>
    facts.cleared.plan.storageState === undefined
        ? undefined
        : { code: "storage-state-unsupported" };

const refuseElementCheckNoDriverDecides: PreflightCheck = (facts) =>
    everyPlanStep(facts.cleared.plan).some(isElementCheckNoDriverDecides)
        ? { code: "element-check-unsupported" }
        : undefined;

// Cleanup counts too: with no way to run it, the steps would leave their test data behind.
const refuseUnwiredDatabaseCommands: PreflightCheck = (facts) =>
    runsDatabaseCommands(facts.cleared.plan) && facts.databaseCommands === undefined
        ? { code: "database-commands-unavailable" }
        : undefined;

// A result reports the first refusal, so this order is part of the behaviour: a production origin
// first, then a missing secret, then the rest in this order.
const CHECKS_BEFORE_SECRETS: readonly PreflightCheck[] = [refuseProductionOrigin];
const CHECKS_AFTER_SECRETS: readonly PreflightCheck[] = [
    refuseMissingScriptSource,
    refuseUnwiredServices,
    refuseStorageState,
    refuseElementCheckNoDriverDecides,
    refuseUnwiredDatabaseCommands,
];

const firstRefusal = (
    checks: readonly PreflightCheck[],
    facts: PreflightFacts,
): Refusal | undefined =>
    checks.map((check) => check(facts)).find((refusal) => refusal !== undefined);

// The first reason the run cannot go ahead, or what it runs with when nothing stops it.
export function checkPreflight(facts: PreflightFacts): Result<PreflightPassed, Refusal> {
    const beforeSecrets = firstRefusal(CHECKS_BEFORE_SECRETS, facts);
    if (beforeSecrets !== undefined) {
        return failure(beforeSecrets);
    }
    if (!facts.secrets.ok) {
        return failure({ code: "secret-missing", secretName: facts.secrets.error });
    }
    const afterSecrets = firstRefusal(CHECKS_AFTER_SECRETS, facts);
    if (afterSecrets !== undefined) {
        return failure(afterSecrets);
    }
    return success({
        secrets: facts.secrets.value,
        services: facts.services ?? NO_SERVICE_CALLER,
        databaseCommands: facts.databaseCommands ?? NO_COMMAND_RUNNER,
    });
}
