// What a run logs and redacts with, from its first log entry, whether or not it was cleared.
import type { Redactor } from "@revisum/contracts";
import { canonicalJson, sha256 } from "../foundation/Sha256.ts";
import { manifestLogger, type Logger } from "./logging/LoggingManifest.ts";
import { withSecretRedaction, type ResolvedSecrets } from "../secrets/ResolvePlanSecrets.ts";
import type { RunPorts } from "./RunContext.ts";
import type { RunSubject } from "./seal/SealResult.ts";

export type RunLogging = { readonly redactor: Redactor; readonly logger: Logger };

// The caller's redactor with the plan's secrets added, and the log that redacts with it.
export function runLogging(
    subject: RunSubject,
    seed: number,
    ports: Pick<RunPorts, "redactor" | "events">,
    secrets: ResolvedSecrets,
): RunLogging {
    const runId = sha256(
        `${sha256(canonicalJson(subject.plan))}:${subject.targetId}:${seed}`,
    ).slice(0, 16);
    const redactor = withSecretRedaction(ports.redactor, secrets);
    return { redactor, logger: manifestLogger(ports.events, redactor, runId) };
}
