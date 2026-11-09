// A run that preflight refused, before any driver call: logged and sealed as Refused.
import { RefusalCode, type PlanRefusal, type PlanRunResult } from "@revisum/contracts";
import { refuse, type Planned } from "../outcome/Transition.ts";
import { logKeepingTheResult } from "../after-the-verdict/ReadKeepingTheResult.ts";
import { refusedResult } from "../seal/RefusedResult.ts";
import { runTimeOfNothingRan, sealResult, type NothingRanContext } from "../seal/SealResult.ts";

// What the event log says of a refusal beyond its code.
type LoggedWithRefusal = { readonly origin?: string; readonly detail?: string };

// The refusal of each code: a member whose code is one of several stands for each of them.
type RefusalWithCode<Code, Each = PlanRefusal> = Each extends PlanRefusal
    ? Code extends Each["code"]
        ? Each
        : never
    : never;
type RefusalOfCode = { readonly [Code in PlanRefusal["code"]]: RefusalWithCode<Code> };
type LoggedWithEachRefusal = {
    readonly [Code in keyof RefusalOfCode]: (refusal: RefusalOfCode[Code]) => LoggedWithRefusal;
};

const LOGGED_WITH_REFUSAL = {
    [RefusalCode.OriginNotAllowed]: (refusal) => ({ origin: refusal.origin }),
    [RefusalCode.SecretMissing]: (refusal) => ({
        detail: `the secret store has no secret named ${refusal.secretName}`,
    }),
    [RefusalCode.ServicesUnavailable]: () => ({}),
    [RefusalCode.StorageStateUnsupported]: () => ({}),
    [RefusalCode.DatabaseCommandsUnavailable]: () => ({}),
    [RefusalCode.ElementCheckUnsupported]: () => ({}),
    [RefusalCode.ScriptSourceMissing]: () => ({}),
} satisfies LoggedWithEachRefusal;

// Takes the code apart from its refusal so the table's entry and its argument are typed together.
function loggedWithRefusalOfCode<Code extends keyof RefusalOfCode>(
    code: Code,
    refusal: RefusalOfCode[Code],
): LoggedWithRefusal {
    const table: LoggedWithEachRefusal = LOGGED_WITH_REFUSAL;
    return table[code](refusal);
}

export function refuseRun(
    planned: Planned,
    refusal: PlanRefusal,
    context: NothingRanContext,
): PlanRunResult {
    const refused = refuse(planned, refusal);
    logKeepingTheResult(
        {
            kind: "run.state",
            state: refused.state,
            targetId: planned.target.id,
            code: refused.refusal.code,
            ...loggedWithRefusalOfCode(refusal.code, refusal),
        },
        context.logger,
    );
    return sealResult(
        refusedResult(refused.refusal, planned.target.id, runTimeOfNothingRan(context)),
        context,
    );
}
