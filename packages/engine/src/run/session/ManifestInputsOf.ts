// What the manifest records of a run whose session opened, before any step runs.
import {
    DATABASE_COMMANDS_INPUT,
    unsafeFeatureRecord,
    type buildManifest,
} from "../seal/BuildManifest.ts";
import { callsServices, runsDatabaseCommands } from "../../plan/CallsServices.ts";
import { secretRecords } from "../../secrets/ResolvePlanSecrets.ts";
import type { PreflightPassed } from "../preflight/CheckPreflight.ts";
import type { RunContext } from "../RunContext.ts";
import type { OpenedSession } from "./OpenSession.ts";

export type ManifestInputs = Parameters<typeof buildManifest>[0];

export function manifestInputsOf(
    context: Pick<RunContext, "cleared" | "inputs" | "secrets">,
    passed: PreflightPassed,
    opened: OpenedSession,
): ManifestInputs {
    const { plan, project, target } = context.cleared;
    const { inputs } = context;
    const unsafe = unsafeFeatureRecord(plan, project, passed.scripts);
    // A database command's output, and the database it ran against, cannot be pinned.
    const unpinned = [
        ...opened.unpinned,
        ...(runsDatabaseCommands(plan) ? [DATABASE_COMMANDS_INPUT] : []),
    ];
    return {
        plan,
        target,
        adapter: opened.driver.info,
        browser: opened.session.browser,
        seed: inputs.seed,
        fixedTimeMilliseconds: inputs.fixedTimeMilliseconds,
        fixtures: inputs.fixtures,
        host: inputs.host,
        ...secretRecords(context.secrets),
        callsServices: callsServices(plan),
        ...(unsafe === undefined ? {} : { unsafe }),
        ...(unpinned.length === 0 ? {} : { unpinned }),
        ...(opened.executableSha256 === undefined
            ? {}
            : { executableSha256: opened.executableSha256 }),
        ...(inputs.pins === undefined ? {} : { pins: { pins: inputs.pins, project } }),
        recordsReplies: project.replay?.recordReplies === true,
    };
}
