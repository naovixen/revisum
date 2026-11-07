// The context of a run that passed preflight: what its steps run with.
import type { SafeText, ValueName } from "@revisum/contracts";
import type { DatabaseCommandContext } from "../../database-commands/database-command-steps.ts";
import type { ClearedRun } from "../../policy/ClearedRun.ts";
import { policyGate } from "../../policy/policy-gate.ts";
import { rememberedValues } from "../../RememberedValues.ts";
import { generateRunValues } from "../../run-values.ts";
import {
    commandSecretStore,
    resolvedSecretStore,
    secretEchoRemoval,
    shortSecretObservation,
} from "../../secrets/secret-resolution.ts";
import type { CallStepContext } from "../../service-calls/call-steps.ts";
import type { PreflightPassed } from "../preflight/CheckPreflight.ts";
import type { RunContext, RunInputs, RunPorts } from "../RunContext.ts";
import type { RunLogging } from "../RunLogging.ts";

export function createRunContext(
    cleared: ClearedRun,
    inputs: RunInputs,
    ports: RunPorts,
    passed: PreflightPassed,
    logging: RunLogging & { readonly determinismUnpinned: boolean },
): RunContext {
    const { plan, project, target } = cleared;
    const { logger } = logging;
    const { secrets } = passed;
    // Generation is pure, so values exist before anything runs.
    const values = new Map<ValueName, SafeText>(
        generateRunValues(plan, inputs.seed, inputs.fixedTimeMilliseconds, target, project),
    );
    const isShortSecret = shortSecretObservation(secrets);
    const withoutSecrets = secretEchoRemoval(secrets);
    const rememberedTexts = new Set<string>();
    const holdsSecret = (text: string): boolean =>
        isShortSecret(text) || withoutSecrets(text) !== text;
    const remembered = rememberedValues({
        values,
        rememberedTexts,
        hasSecret: holdsSecret,
        maximumTextLength: project.limits.maximumTextLength,
        logger,
    });
    const calls: CallStepContext = {
        caller: passed.services,
        project,
        values,
        remembered,
        secrets: resolvedSecretStore(secrets),
        clock: ports.clock,
        logger,
        holdsSecret,
    };
    const commands: DatabaseCommandContext = {
        runner: passed.databaseCommands,
        project,
        values,
        remembered,
        secrets: commandSecretStore(secrets),
        clock: ports.clock,
        logger,
        holdsSecret,
    };
    return {
        cleared,
        inputs,
        ports,
        logger,
        gate: policyGate({ project, events: ports.audit }),
        redactor: logging.redactor,
        secrets,
        planSteps: passed.steps,
        scripts: passed.scripts,
        isShortSecret,
        withoutSecrets,
        holdsSecret,
        secretFilledFields: new Map(),
        values,
        remembered,
        calls,
        commands,
        rememberedTexts,
        downloads: new Map(),
        activeStubs: new Set(),
        determinismUnpinned: logging.determinismUnpinned,
    };
}
