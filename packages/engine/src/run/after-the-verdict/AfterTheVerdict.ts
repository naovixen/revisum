// What a run does once its steps have a verdict: the plan's cleanup, whatever the outcome, then what
// the egress refused, which the result claims, and the run's last log entries.
import { failure, success, type Result, type Session } from "@revisum/contracts";
import { finish } from "../../lifecycle.ts";
import { runCleanup, type CleanupResult } from "../../service-calls/call-steps.ts";
import type { SessionContext } from "../executors/StepExecutor.ts";
import { EGRESS_UNREAD, type RunReviewItem } from "../RunResult.ts";
import type { FinishedRun, StepsVerdict } from "../steps/VerdictOfSteps.ts";
import { logFailureAfterTheVerdict, readKeepingTheResult } from "./ReadKeepingTheResult.ts";

export type AfterTheVerdict = {
    readonly cleanup: readonly CleanupResult[] | undefined;
    readonly reviewItems: readonly RunReviewItem[];
    readonly blocked: readonly string[];
    // The egress could not say what it refused, so the run cannot claim it was enforced.
    readonly isEgressUnread: boolean;
    readonly endState: FinishedRun;
};

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
    const cleanupItems = (cleanup ?? []).flatMap((done): RunReviewItem[] =>
        done.outcome === "failed" ? [{ code: "cleanup-failed", cleanupIndex: done.index }] : [],
    );
    const blockedRead = readBlockedOrigins(context.session);
    if (!blockedRead.ok) {
        logFailureAfterTheVerdict(EGRESS_UNREAD, blockedRead.error, context.logger);
    }
    const blocked = blockedRead.ok ? blockedRead.value : [];
    const reviewItems: readonly RunReviewItem[] = blockedRead.ok
        ? cleanupItems
        : [...cleanupItems, { code: EGRESS_UNREAD }];
    const endState = blockedRead.ok ? verdict.finished : finish(verdict.running, "Errored");
    logTheEnd(context, blocked, endState);
    return { cleanup, reviewItems, blocked, isEgressUnread: !blockedRead.ok, endState };
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
    endState: FinishedRun,
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
                state: endState.state,
                targetId: context.cleared.target.id,
                ...(endState.state === "Denied"
                    ? { code: endState.denial.rule, stepIndex: endState.denial.stepIndex }
                    : {}),
            });
        },
        undefined,
        logger,
    );
}
