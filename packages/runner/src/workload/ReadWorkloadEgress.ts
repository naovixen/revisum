// What the proxy decided for a workload, read back from its container and turned into egress events.
import type { EgressEvent, ProxyDecision } from "@revisum/contracts";
import type { ContainerEngine } from "../container-engine.ts";
import { joinEgressEvents } from "../egress-events.ts";
import { hasProxyLostRecords, readDecisions, readLookups } from "../run-containers.ts";
import type { CheckedWorkloadRequest } from "./CheckWorkloadRequest.ts";
import { processEvents } from "./ProcessEvents.ts";
import type { WorkloadLog } from "./WorkloadRefusal.ts";

type WorkloadEgressRecord = {
    readonly events: readonly EgressEvent[];
    readonly isUnread: boolean;
};

// A relayed connection is the command's own, not a browser's: its channel is process.
function relayEvents(
    decisions: readonly ProxyDecision[],
    relayedOrigins: ReadonlySet<string>,
): readonly EgressEvent[] {
    return decisions
        .filter((decision) => relayedOrigins.has(decision.origin))
        .map((decision): EgressEvent => ({
            origin: decision.origin,
            channel: "process",
            decision: decision.decision,
        }));
}

export async function readWorkloadEgress(
    engine: ContainerEngine,
    proxyId: string,
    checked: CheckedWorkloadRequest,
    log: WorkloadLog,
): Promise<WorkloadEgressRecord> {
    const decisionsRead = await readDecisions(engine, proxyId);
    const lookupsRead = await readLookups(engine, proxyId);
    // A proxy that cannot be read is not a proxy that blocked nothing.
    const isUnread =
        decisionsRead === null ||
        lookupsRead === null ||
        (await hasProxyLostRecords(engine, proxyId));
    if (isUnread) {
        log({ code: "notice", detail: "what the proxy decided could not be read back whole" });
    }
    const decisions = decisionsRead ?? [];
    const lookups = lookupsRead ?? [];
    const { relayedOrigins } = checked;
    return {
        events: [
            ...joinEgressEvents(
                [],
                decisions.filter((decision) => !relayedOrigins.has(decision.origin)),
            ),
            ...relayEvents(decisions, relayedOrigins),
            ...processEvents(lookups, decisions, checked.policy),
        ],
        isUnread,
    };
}
