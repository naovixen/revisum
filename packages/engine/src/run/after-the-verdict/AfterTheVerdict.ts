// What a run does once its steps have a verdict: the plan's cleanup, whatever the outcome, then what
// the egress refused, which the result claims, and the run's last log entries.
import {
    failure,
    RunReviewItemCode,
    StepOutcome,
    success,
    TerminalState,
    type CleanupResult,
    type Denial,
    type Result,
    type RunReviewItem,
    type Session,
} from "@revisum/contracts";
import { runCleanup } from "../../service-calls/call-steps.ts";
import type { SessionContext } from "../executors/StepExecutor.ts";
import type { FinishedRun, StepsVerdict } from "../steps/VerdictOfSteps.ts";
import { RECORD_UNREAD, readValueOr, recordRead, type RecordRead } from "./RecordRead.ts";
import { logFailureAfterTheVerdict, readKeepingTheResult } from "./ReadKeepingTheResult.ts";

export type AfterTheVerdict = {
    readonly cleanup: readonly CleanupResult[] | undefined;
    readonly cleanupReviewItems: readonly RunReviewItem[];
    // The origins the egress refused.
    readonly egress: RecordRead<readonly string[]>;
    readonly end: EndOfTheRun;
};

// The state the run ends in, and the denial a denied run keeps: a denied run whose egress then went
// unread ends Errored, since it cannot show its egress was enforced, and still keeps its denial.
export type EndOfTheRun =
    | {
          readonly state:
              | typeof TerminalState.Passed
              | typeof TerminalState.Failed
              | typeof TerminalState.Errored;
      }
    | {
          readonly state: typeof TerminalState.Denied | typeof TerminalState.Errored;
          readonly denial: Denial;
      };

function endOfTheRun(finished: FinishedRun, isEgressRead: boolean): EndOfTheRun {
    if (finished.state === TerminalState.Denied) {
        return {
            state: isEgressRead ? TerminalState.Denied : TerminalState.Errored,
            denial: finished.denial,
        };
    }
    return { state: isEgressRead ? finished.state : TerminalState.Errored };
}

// What the run's last part uses: the plan's cleanup and how it calls, the closed session's records
// and the log.
type AfterTheVerdictContext = Pick<
    SessionContext,
    "cleared" | "calls" | "commands" | "session" | "logger"
>;

export async function afterTheVerdict(
    context: AfterTheVerdictContext,
    verdict: StepsVerdict,
): Promise<AfterTheVerdict> {
    const { plan } = context.cleared;
    // A failing cleanup step never changes the verdict; it raises a review item.
    const cleanup =
        plan.cleanup === undefined
            ? undefined
            : await runCleanup(plan.cleanup, plan.steps.length, context.calls, context.commands);
    const cleanupReviewItems = (cleanup ?? []).flatMap((done): RunReviewItem[] =>
        done.outcome === StepOutcome.Failed
            ? [{ code: RunReviewItemCode.CleanupFailed, cleanupIndex: done.index }]
            : [],
    );
    const blockedRead = readBlockedOrigins(context.session);
    if (!blockedRead.ok) {
        logFailureAfterTheVerdict(
            RunReviewItemCode.EgressUnread,
            blockedRead.error,
            context.logger,
        );
    }
    const egress = blockedRead.ok ? recordRead(blockedRead.value) : RECORD_UNREAD;
    const end = endOfTheRun(verdict.finished, blockedRead.ok);
    logTheEnd(context, readValueOr(egress, []), end);
    return { cleanup, cleanupReviewItems, egress, end };
}

// The result claims what the egress refused and is hashed with that claim in it. So this is the one
// record read after the verdict that can't take an empty default: an empty list says nothing was
// refused, and when that isn't known the run has no verdict to give.
function readBlockedOrigins(session: Session): Result<readonly string[], unknown> {
    try {
        return success([...new Set(session.blockedOrigins())].sort());
    } catch (error) {
        return failure(error);
    }
}

// The connections that failed, the origins the egress refused and the state the run ended in.
function logTheEnd(
    context: AfterTheVerdictContext,
    blocked: readonly string[],
    end: EndOfTheRun,
): void {
    const { session, logger } = context;
    readKeepingTheResult(
        () => {
            for (const { origin, message } of session.connectionFailures()) {
                logger.log({ kind: "session.connection-failed", origin, detail: message });
            }
        },
        undefined,
        logger,
    );
    readKeepingTheResult(
        () => {
            for (const origin of blocked) {
                logger.log({ kind: "network.blocked", origin });
            }
            logger.log({
                kind: "run.state",
                state: end.state,
                targetId: context.cleared.target.id,
                ...(end.state === TerminalState.Denied
                    ? { code: end.denial.rule, stepIndex: end.denial.stepIndex }
                    : {}),
            });
        },
        undefined,
        logger,
    );
}
