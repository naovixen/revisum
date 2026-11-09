// Replay from a manifest: run the recorded run again with the manifest's seed, clock start and
// fixtures, and compare result hashes. Everything a replay is handed is checked before any driver
// call: the manifest (and the recording, when the run recorded replies) is decoded, the run must be
// replay-claimed, the plan must hash to the manifest's plan hash, the target must be the manifest's
// and every fixture must have the hash the manifest names. A replay never sends a service call or
// runs a database command: those replies come from the recording, through ports that send nothing.
//
// The outcome says whether the result hash matches the recorded one, which top-level manifest
// fields differ, and a verdict. A replay whose only differences are the machine it ran on (host,
// browser, its build, run image, fonts or versions) and that ended in the recorded state is a
// per-environment baseline; any other difference is a mismatch, a changed verdict in either direction
// among them. Neither is a pass. The result hash leaves out the blocked origins, so a replay that
// differs only in those is identical.
// Pure apart from calling run.
import {
    failure,
    success,
    type DatabaseCommandRunner,
    type Result,
    type ServiceCaller,
    type TerminalState,
    type PlanRunManifest,
} from "@revisum/contracts";
import { canonicalJson, sha256 } from "../foundation/Sha256.ts";
import {
    DATABASE_COMMANDS_INPUT,
    ReplayErrorCode,
    SERVICE_CALLS_INPUT,
    manifestHash,
    planHash,
    replayManifest,
} from "../run/seal/BuildManifest.ts";
import type { ClearedRun } from "../policy/ClearedRun.ts";
import type { RunInputs, RunPorts } from "../run/RunContext.ts";
import { createRunService } from "../run/RunService.ts";
import { noDatabaseCommandRunner, noServiceCaller } from "../run/UnwiredPorts.ts";
import { decodeManifest } from "./DecodeManifest.ts";
import {
    decodeRecording,
    replayedDatabaseCommands,
    replayedServices,
    type RecordedReplyKind,
    type ReplayedPort,
    type RunRecording,
} from "./RunRecording.ts";

// What a replay is given: the recorded manifest and, for a run that recorded replies, its
// recording (null when none was kept), both as read from disk; the recorded result hash and the
// state the recorded run ended in; the run the policy gate cleared; and the run's inputs apart from
// the seed, clock start and fixtures, which come from the manifest.
export type ReplayRequest = {
    readonly manifest: unknown;
    readonly recording: unknown;
    readonly recordedResultHash: string;
    readonly recordedState: TerminalState;
    readonly cleared: ClearedRun;
    readonly inputs: Omit<RunInputs, "seed" | "fixedTimeMilliseconds" | "fixtures">;
};

// Reads a fixture of the app under test by the path the manifest names it by; null when missing.
export type FixtureReader = { read(path: string): Promise<Uint8Array | null> };

// A run's ports without a service caller or a command runner, so a replay cannot be handed a live
// one, and with the fixture reader.
export type ReplayPorts = Omit<RunPorts, "services" | "databaseCommands"> & {
    readonly fixtures: FixtureReader;
};

export type ReplayVerdict = "identical" | "per-environment-baseline" | "mismatch";

// identical is true exactly when the replay's result hash and end state are the recorded ones and its
// manifest is the one given (a recorded hash cannot stand for another manifest). manifestHash is the
// replay's own, null when it made no manifest. differingInputs lists the top-level manifest fields
// whose canonical JSON differs from the recorded manifest's.
export type ReplayOutcome = {
    readonly identical: boolean;
    readonly resultHash: string;
    readonly manifestHash: string | null;
    readonly differingInputs: readonly string[];
    readonly verdict: ReplayVerdict;
};

// Why a replay ended without an outcome. A replay-mismatch names what did not match: a fixture by
// its path; the manifest's plan hash, target, or a field of the wrong shape by JSON path; or the
// recorded reply of a call or command by its position, counted from 0.
export type ReplayError =
    | { readonly code: typeof ReplayErrorCode.ReplayNotClaimed }
    | { readonly code: typeof ReplayErrorCode.VersionUnsupported; readonly path: string }
    | { readonly code: typeof ReplayErrorCode.ReplayMismatch; readonly path: string }
    | { readonly code: typeof ReplayErrorCode.ReplayMismatch; readonly fixture: string }
    | {
          readonly code: typeof ReplayErrorCode.ReplayMismatch;
          readonly kind: RecordedReplyKind;
          readonly position: number;
      };

// The manifest fields that describe the machine a run ran on rather than what it tested: a replay
// that differs only in these is a per-environment baseline.
export const PER_ENVIRONMENT_INPUTS: readonly string[] = [
    "host",
    "browser",
    "executableSha256",
    "imageDigest",
    "fontsSha256",
    "versions",
];

// The recorded replies a replay feeds its run, for the ports the recorded run had.
type ReplayedReplies = {
    readonly services?: ReplayedPort<ServiceCaller>;
    readonly databaseCommands?: ReplayedPort<DatabaseCommandRunner>;
};

// The replies the manifest needs from the recording, or why the replay cannot have them. A run
// with no calls or commands needs none, and any recording given is ignored.
function repliesFor(
    manifest: PlanRunManifest,
    input: unknown,
    ports: ReplayPorts,
): Result<ReplayedReplies, ReplayError> {
    const callsServices = manifest.nonHermeticInputs.includes(SERVICE_CALLS_INPUT);
    const runsCommands = manifest.nonHermeticInputs.includes(DATABASE_COMMANDS_INPUT);
    if (!callsServices && !runsCommands) {
        return success({});
    }
    const firstKind: RecordedReplyKind = callsServices ? "service-call" : "database-command";
    if (input === null || input === undefined) {
        return failure({ code: ReplayErrorCode.ReplayMismatch, kind: firstKind, position: 0 });
    }
    const decoded = decodeRecording(input);
    if (!decoded.ok) {
        return decoded;
    }
    const recording: RunRecording = decoded.value;
    if (recording.manifestHash !== manifestHash(manifest)) {
        return failure({ code: ReplayErrorCode.ReplayMismatch, path: "$.manifestHash" });
    }
    if (callsServices && recording.serviceCalls === undefined) {
        return failure({ code: ReplayErrorCode.ReplayMismatch, kind: "service-call", position: 0 });
    }
    if (runsCommands && recording.databaseCommands === undefined) {
        return failure({
            code: ReplayErrorCode.ReplayMismatch,
            kind: "database-command",
            position: 0,
        });
    }
    return success({
        ...(recording.serviceCalls === undefined
            ? {}
            : { services: replayedServices(recording.serviceCalls, ports.secrets) }),
        ...(recording.databaseCommands === undefined
            ? {}
            : {
                  databaseCommands: replayedDatabaseCommands(
                      recording.databaseCommands,
                      ports.secrets,
                  ),
              }),
    });
}

// The first fixture the reader does not hold, or holds with another hash, by its path.
async function fixtureMismatch(
    manifest: PlanRunManifest,
    reader: FixtureReader,
): Promise<string | null> {
    for (const fixture of manifest.fixtures) {
        const bytes = await reader.read(fixture.path);
        if (bytes === null || sha256(bytes) !== fixture.sha256) {
            return fixture.path;
        }
    }
    return null;
}

// The top-level fields whose canonical JSON differs between two manifests, sorted.
function differingFields(recorded: PlanRunManifest, replayed: PlanRunManifest): string[] {
    const fields = new Set([...Object.keys(recorded), ...Object.keys(replayed)]);
    const text = (manifest: PlanRunManifest, field: string): string => {
        const value: unknown = Object.getOwnPropertyDescriptor(manifest, field)?.value;
        return value === undefined ? "" : canonicalJson(value);
    };
    return [...fields].filter((field) => text(recorded, field) !== text(replayed, field)).sort();
}

export async function replay(
    request: ReplayRequest,
    ports: ReplayPorts,
): Promise<Result<ReplayOutcome, ReplayError>> {
    const decoded = decodeManifest(request.manifest);
    if (!decoded.ok) {
        return decoded;
    }
    const claimed = replayManifest(decoded.value);
    if (!claimed.ok) {
        return claimed;
    }
    const manifest = claimed.value;
    const replies = repliesFor(manifest, request.recording, ports);
    if (!replies.ok) {
        return replies;
    }
    if (planHash(request.cleared.plan) !== manifest.planHash) {
        return failure({ code: ReplayErrorCode.ReplayMismatch, path: "$.planHash" });
    }
    if (manifest.target.id !== request.cleared.targetId) {
        return failure({ code: ReplayErrorCode.ReplayMismatch, path: "$.target.id" });
    }
    const fixture = await fixtureMismatch(manifest, ports.fixtures);
    if (fixture !== null) {
        return failure({ code: ReplayErrorCode.ReplayMismatch, fixture });
    }

    // Only the ports a run takes are passed on: whatever else the caller's object holds, such as a
    // live caller, never reaches the run.
    const { services, databaseCommands } = replies.value;
    const runPorts: RunPorts = {
        drivers: ports.drivers,
        clock: ports.clock,
        artifacts: ports.artifacts,
        redactor: ports.redactor,
        events: ports.events,
        audit: ports.audit,
        isolation: ports.isolation,
        secrets: ports.secrets,
        rewritesApplied: ports.rewritesApplied,
        services: services?.port ?? noServiceCaller,
        databaseCommands: databaseCommands?.port ?? noDatabaseCommandRunner,
    };
    const result = await createRunService(runPorts).run(request.cleared, {
        ...request.inputs,
        seed: manifest.seeds.random,
        fixedTimeMilliseconds: manifest.clock.fixedTimeMilliseconds,
        fixtures: manifest.fixtures,
    });

    const callMismatch = services?.mismatchAt() ?? null;
    if (callMismatch !== null) {
        return failure({
            code: ReplayErrorCode.ReplayMismatch,
            kind: "service-call",
            position: callMismatch,
        });
    }
    const commandMismatch = databaseCommands?.mismatchAt() ?? null;
    if (commandMismatch !== null) {
        return failure({
            code: ReplayErrorCode.ReplayMismatch,
            kind: "database-command",
            position: commandMismatch,
        });
    }

    // The result hash covers the manifest's hash, so a recorded result hash can only stand for the
    // manifest given when the replay's own manifest is that manifest too.
    const hasSameState = result.state === request.recordedState;
    const isIdentical =
        hasSameState &&
        result.resultHash === request.recordedResultHash &&
        result.manifestHash === manifestHash(manifest);
    const differingInputs =
        result.manifest === null ? [] : differingFields(manifest, result.manifest);
    const isPerEnvironment =
        hasSameState &&
        differingInputs.length > 0 &&
        differingInputs.every((field) => PER_ENVIRONMENT_INPUTS.includes(field));
    return success({
        identical: isIdentical,
        resultHash: result.resultHash,
        manifestHash: result.manifestHash,
        differingInputs,
        verdict: replayVerdict(isIdentical, isPerEnvironment),
    });
}

function replayVerdict(isIdentical: boolean, isPerEnvironment: boolean): ReplayVerdict {
    if (isIdentical) {
        return "identical";
    }
    return isPerEnvironment ? "per-environment-baseline" : "mismatch";
}
