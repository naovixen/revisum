// A run whose target was unavailable, so no step ran: logged and sealed as TargetUnavailable.
import type { Unavailable } from "@revisum/contracts";
import { logKeepingTheResult } from "../after-the-verdict/ReadKeepingTheResult.ts";
import type { RunResult } from "../RunResult.ts";
import { targetUnavailableResult } from "./NothingRanResult.ts";
import { sealResult, type NothingRanContext } from "./SealResult.ts";

export function unavailableResult(
    targetId: string,
    unavailable: Unavailable,
    context: NothingRanContext,
    startedAt: number,
): RunResult {
    logKeepingTheResult(
        { kind: "run.state", state: "TargetUnavailable", targetId, code: unavailable.reason },
        context.logger,
    );
    return sealResult(
        targetUnavailableResult(unavailable, targetId, context.ports.clock.now() - startedAt),
        context,
    );
}
