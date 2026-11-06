// Preflight: every "can this run at all" check, made before any side effect, in one ordered table.
// Each check reads only the cleared run and what the run was handed, so a refusal leaves nothing
// behind: no browser opened, no call sent, no command run.
import {
    isElementCheckNoDriverDecides,
    type BaseUrl,
    type Result,
    type SecretName,
} from "@revisum/contracts";
import type { Refusal } from "./lifecycle.ts";
import { missingScriptSource } from "./manifest.ts";
import { callsServices, runsDatabaseCommands } from "./plan/CallsServices.ts";
import { everyPlanStep } from "./plan/plan-parser.ts";
import type { ClearedRun } from "./policy/ClearedRun.ts";
import { isProductionAllowed, productionOriginReached } from "./ReachableOrigins.ts";
import type { ResolvedSecrets } from "./secrets/secret-resolution.ts";

export type PreflightFacts = {
    readonly cleared: ClearedRun;
    readonly baseUrl: BaseUrl;
    // The plan's secrets as the store resolved them, or the first name it could not.
    readonly secrets: Result<ResolvedSecrets, SecretName>;
    readonly scriptSources: Readonly<Record<string, Uint8Array>>;
    readonly hasServiceCaller: boolean;
    readonly hasCommandRunner: boolean;
};

type PreflightCheck = (facts: PreflightFacts) => Refusal | undefined;

const refuseProductionOrigin: PreflightCheck = (facts) => {
    const origin = isProductionAllowed(facts.cleared)
        ? undefined
        : productionOriginReached(facts.cleared, facts.baseUrl);
    return origin === undefined ? undefined : { code: "origin-not-allowed", origin };
};

const refuseMissingSecret: PreflightCheck = (facts) =>
    facts.secrets.ok ? undefined : { code: "secret-missing", secretName: facts.secrets.error };

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
    callsServices(facts.cleared.plan) && !facts.hasServiceCaller
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
    runsDatabaseCommands(facts.cleared.plan) && !facts.hasCommandRunner
        ? { code: "database-commands-unavailable" }
        : undefined;

// A result reports the first refusal, so this order is part of the behaviour.
const PREFLIGHT_CHECKS: readonly PreflightCheck[] = [
    refuseProductionOrigin,
    refuseMissingSecret,
    refuseMissingScriptSource,
    refuseUnwiredServices,
    refuseStorageState,
    refuseElementCheckNoDriverDecides,
    refuseUnwiredDatabaseCommands,
];

// The first reason the run cannot go ahead, or undefined when nothing stops it.
export function findPreflightRefusal(facts: PreflightFacts): Refusal | undefined {
    for (const check of PREFLIGHT_CHECKS) {
        const refusal = check(facts);
        if (refusal !== undefined) {
            return refusal;
        }
    }
    return undefined;
}
