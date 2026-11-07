// A run that preflight refused, before any driver call: logged and sealed as Refused.
import { refuse, type Planned, type Refusal } from "../../lifecycle.ts";
import { logKeepingTheResult } from "../after-the-verdict/ReadKeepingTheResult.ts";
import type { RunResult } from "../RunResult.ts";
import { refusedResult } from "../seal/NothingRanResult.ts";
import { sealResult, type NothingRanContext } from "../seal/SealResult.ts";

// What the event log says of a refusal beyond its code.
function loggedWithRefusal(refusal: Refusal): {
    readonly origin?: string;
    readonly detail?: string;
} {
    switch (refusal.code) {
        case "origin-not-allowed":
            return { origin: refusal.origin };
        case "secret-missing":
            return { detail: `the secret store has no secret named ${refusal.secretName}` };
        default:
            return {};
    }
}

export function refuseRun(
    planned: Planned,
    refusal: Refusal,
    context: NothingRanContext,
    startedAt: number,
): RunResult {
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
