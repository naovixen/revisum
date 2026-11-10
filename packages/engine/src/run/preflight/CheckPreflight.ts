// Preflight: the checks that refuse a cleared run before any side effect, in one fixed order: a
// base URL on an origin the project does not declare, a production origin the run may not reach, a missing secret, a page script whose source is missing,
// services or database commands the plan needs with nothing to run them, a saved storage state, and
// an element check no driver decides. Each reads only the cleared run and what the run was handed,
// so a refusal leaves nothing behind: no browser opened, no call sent, no command run. A run that
// passes gets what those checks proved, so nothing after them checks again: its steps with each
// fill's secret, and the page scripts it names with their sources.
//
// What the target itself allows is not here, and ends a run TargetUnavailable rather than Refused:
// a target the plan or the matrix does not declare never becomes a cleared run (the policy gate
// gives it a TargetNotDeclared), and an adapter that is not registered, one whose `supports` says no
// and a browser build other than the pinned one are found as the run opens its session.
import {
    RefusalCode,
    failure,
    isElementCheckNoDriverDecides,
    isWiredPort,
    success,
    type BaseUrl,
    type DatabaseCommandRunner,
    type Plan,
    type Result,
    type SecretName,
    type SecretStore,
    type ServiceCaller,
    type PlanRefusal,
    type UnwiredPort,
} from "@revisum/contracts";
import {
    namedScriptSources,
    type NamedScripts,
} from "../executors/page-scripts/NamedScriptSources.ts";
import { callsServices, runsDatabaseCommands } from "../../plan/CallsServices.ts";
import { everyPlanStep } from "../../plan/VisitSteps.ts";
import type { ClearedRun } from "../../policy/ClearedRun.ts";
import { isProductionAllowed } from "../../policy/IsProductionAllowed.ts";
import type { Project } from "../../project/ParseProject.ts";
import { declaredCommands } from "../../project/ReadUnsafeFeatures.ts";
import { productionOriginReached } from "../../policy/ReachableOrigins.ts";
import type { RunStep } from "../steps/RunStep.ts";
import {
    NO_SECRETS,
    resolvePlanSecrets,
    type PlanSecrets,
    type ResolvedSecrets,
} from "../../secrets/ResolvePlanSecrets.ts";
import { databaseCommandRunnerOf, serviceCallerOf } from "../UnwiredPorts.ts";

export type PreflightFacts = {
    readonly cleared: ClearedRun;
    readonly baseUrl: BaseUrl;
    // Where the plan's secrets are resolved.
    readonly secretStore: SecretStore;
    readonly scriptSources: Readonly<Record<string, Uint8Array>>;
    readonly services: ServiceCaller | UnwiredPort;
    readonly databaseCommands: DatabaseCommandRunner | UnwiredPort;
};

// What a run that passed preflight runs with. The secrets are every one the plan names, resolved,
// and the steps are the plan's, each fill of a secret carrying its own. The scripts are every page
// script the plan names, with its source. The service caller and command runner are the run's own,
// or, for a plan that needs neither, ones it never calls.
export type PreflightPassed = {
    readonly secrets: ResolvedSecrets;
    readonly steps: readonly RunStep[];
    readonly scripts: NamedScripts;
    readonly services: ServiceCaller;
    readonly databaseCommands: DatabaseCommandRunner;
};

// What preflight decided, and the secrets the run redacts with whatever it decided: every one the
// plan names, or none when one is missing.
export type Preflight = {
    readonly redaction: ResolvedSecrets;
    readonly outcome: Result<PreflightPassed, PlanRefusal>;
};

type PreflightCheck = (facts: PreflightFacts) => PlanRefusal | undefined;

// A plan's relative paths resolve against the base URL, and the browser may reach only the project's
// origins, so on any other origin every relative navigate would fail part way through the run.
const refuseBaseUrlOffProject: PreflightCheck = (facts) => {
    const origin = new URL(facts.baseUrl).origin;
    return facts.cleared.project.origins.some((declared) => declared === origin)
        ? undefined
        : { code: RefusalCode.OriginNotAllowed, origin };
};

const refuseProductionOrigin: PreflightCheck = (facts) => {
    const origin = isProductionAllowed(facts.cleared.standing, facts.cleared.project.policy)
        ? undefined
        : productionOriginReached(facts.cleared, facts.baseUrl);
    return origin === undefined ? undefined : { code: RefusalCode.OriginNotAllowed, origin };
};

// A plan that needs one of the next four relies on it to mean anything: stopping part way would leave
// test data behind or report on a run that never had what it declared.
const refuseUnwiredServices: PreflightCheck = (facts) =>
    callsServices(facts.cleared.plan) && !isWiredPort(facts.services)
        ? { code: RefusalCode.ServicesUnavailable }
        : undefined;

// A plan that names it relies on being signed in. Loading it comes with the driver's session
// environment; until then no run can honour it, so the plan parses and every run of it is refused.
const refuseStorageState: PreflightCheck = (facts) =>
    facts.cleared.plan.storageState === undefined
        ? undefined
        : { code: RefusalCode.StorageStateUnsupported };

const refuseElementCheckNoDriverDecides: PreflightCheck = (facts) =>
    everyPlanStep(facts.cleared.plan).some(isElementCheckNoDriverDecides)
        ? { code: RefusalCode.ElementCheckUnsupported }
        : undefined;

// Cleanup counts too: with no way to run it, the steps would leave their test data behind.
const refuseUnwiredDatabaseCommands: PreflightCheck = (facts) =>
    runsDatabaseCommands(facts.cleared.plan) && !isWiredPort(facts.databaseCommands)
        ? { code: RefusalCode.DatabaseCommandsUnavailable }
        : undefined;

// A result reports the first refusal, so this order is part of the behaviour: a base URL off the
// project's origins first, then a production origin, then a missing secret, then a page script's missing source, then the rest in this order.
const CHECKS_AFTER_SCRIPTS: readonly PreflightCheck[] = [
    refuseUnwiredServices,
    refuseStorageState,
    refuseElementCheckNoDriverDecides,
    refuseUnwiredDatabaseCommands,
];

const firstRefusal = (
    checks: readonly PreflightCheck[],
    facts: PreflightFacts,
): PlanRefusal | undefined =>
    checks.map((check) => check(facts)).find((refusal) => refusal !== undefined);

// The secrets a plan names, resolved. A database command's secrets are resolved only for a run that
// can run commands: without a runner, a plan with a command is refused
// database-commands-unavailable, after every check before it, rather than secret-missing for a
// secret no command of the run would use.
const resolvePreflightSecrets = (
    subject: { readonly plan: Plan; readonly project: Project },
    secretStore: SecretStore,
    databaseCommands: DatabaseCommandRunner | UnwiredPort,
): Result<PlanSecrets, SecretName> =>
    resolvePlanSecrets(
        subject.plan,
        secretStore,
        subject.project.calls,
        isWiredPort(databaseCommands) ? declaredCommands(subject.project.unsafeFeatures) : {},
    );

// The first reason the run cannot go ahead, or what it runs with when nothing stops it.
function passedOrRefused(
    facts: PreflightFacts,
    secrets: Result<PlanSecrets, SecretName>,
): Result<PreflightPassed, PlanRefusal> {
    const origin = firstRefusal([refuseBaseUrlOffProject, refuseProductionOrigin], facts);
    if (origin !== undefined) {
        return failure(origin);
    }
    if (!secrets.ok) {
        return failure({ code: RefusalCode.SecretMissing, secretName: secrets.error });
    }
    // Without every source, the manifest could not record what would run.
    const scripts = namedScriptSources(
        facts.cleared.plan,
        facts.cleared.project,
        facts.scriptSources,
    );
    if (!scripts.ok) {
        return failure({ code: RefusalCode.ScriptSourceMissing, file: scripts.error });
    }
    const afterScripts = firstRefusal(CHECKS_AFTER_SCRIPTS, facts);
    if (afterScripts !== undefined) {
        return failure(afterScripts);
    }
    return success({
        secrets: secrets.value.secrets,
        steps: secrets.value.steps,
        scripts: scripts.value,
        services: serviceCallerOf(facts.services),
        databaseCommands: databaseCommandRunnerOf(facts.databaseCommands),
    });
}

const redactionOf = (secrets: Result<PlanSecrets, SecretName>): ResolvedSecrets =>
    secrets.ok ? secrets.value.secrets : NO_SECRETS;

// Resolving reads only the store, so it is done once, before anything is logged: the run redacts
// with the secrets even when preflight refuses it.
export function checkPreflight(facts: PreflightFacts): Preflight {
    const secrets = resolvePreflightSecrets(
        facts.cleared,
        facts.secretStore,
        facts.databaseCommands,
    );
    return { redaction: redactionOf(secrets), outcome: passedOrRefused(facts, secrets) };
}

// What a result for a target no run was cleared for redacts with: the same secrets a cleared run of
// its plan would.
export const secretsToRedact = (
    subject: { readonly plan: Plan; readonly project: Project },
    secretStore: SecretStore,
    databaseCommands: DatabaseCommandRunner | UnwiredPort,
): ResolvedSecrets => redactionOf(resolvePreflightSecrets(subject, secretStore, databaseCommands));
