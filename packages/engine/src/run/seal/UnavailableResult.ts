// A run whose target was unavailable, so no step ran: logged and sealed as TargetUnavailable.
import type { PlanRunResult, Unavailable } from "@revisum/contracts";
import { logKeepingTheResult } from "../after-the-verdict/ReadKeepingTheResult.ts";
import { targetUnavailableResult } from "./RefusedResult.ts";
import { runTimeOfNothingRan, sealResult, type NothingRanContext } from "./SealResult.ts";
import { EventKind } from "../logging/LoggingManifest.ts";

export function unavailableResult(
    targetId: string,
    unavailable: Unavailable,
    context: NothingRanContext,
): PlanRunResult {
    logKeepingTheResult(
        { kind: EventKind.RunState, state: "TargetUnavailable", targetId, code: unavailable.reason },
        context.logger,
    );
    return sealResult(
        targetUnavailableResult(unavailable, targetId, runTimeOfNothingRan(context)),
        context,
    );
}
