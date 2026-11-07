// A run that preflight refused, before any driver call: logged and sealed as Refused.
import { RefusalCode, type PlanRefusal, type PlanRunResult } from "@revisum/contracts";
import { refuse, type Planned } from "../../lifecycle.ts";
import { logKeepingTheResult } from "../after-the-verdict/ReadKeepingTheResult.ts";
import { refusedResult } from "../seal/RefusedResult.ts";
import { sealResult, type NothingRanContext } from "../seal/SealResult.ts";

// What the event log says of a refusal beyond its code.
function loggedWithRefusal(refusal: PlanRefusal): {
    readonly origin?: string;
    readonly detail?: string;
} {
    switch (refusal.code) {
        case RefusalCode.OriginNotAllowed:
            return { origin: refusal.origin };
        case RefusalCode.SecretMissing:
            return { detail: `the secret store has no secret named ${refusal.secretName}` };
        default:
            return {};
    }
}

export function refuseRun(
    planned: Planned,
    refusal: PlanRefusal,
    context: NothingRanContext,
    startedAt: number,
): PlanRunResult {
    const refused = refuse(planned, refusal);
    logKeepingTheResult(
        {
            kind: "run.state",
            state: refused.state,
            targetId: planned.target.id,
            code: refused.refusal.code,
            ...loggedWithRefusal(refusal),
        },
        context.logger,
    );
    return sealResult(
        refusedResult(refused.refusal, planned.target.id, context.ports.clock.now() - startedAt),
        context,
    );
}
