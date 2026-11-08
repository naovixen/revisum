// What a run does once its steps have a verdict: the plan's cleanup, whatever the outcome, then what
// the egress refused, which the result claims, and the run's last log entries.
import {
    RunReviewItemCode,
    StepOutcome,
    success,
    TerminalState,
    type CleanupResult,
    type Denial,
    type ClosedSession,
    type Result,
    type RunReviewItem,
} from "@revisum/contracts";
import { runCleanup } from "../../service-calls/call-steps.ts";
import type { SessionContext } from "../executors/StepExecutor.ts";
import type { FinishedRun, StepsVerdict } from "../steps/VerdictOfSteps.ts";
import { RECORD_UNREAD, readValueOr, recordRead } from "./RecordRead.ts";
import {
    isVerdictLostToTheRecords,
    type RecordsAfterTheSteps,
    type RecordsBeforeTheEgress,
} from "./RecordsAfterTheSteps.ts";
import {
    closedSessionRecord,
    logFailureAfterTheVerdict,
    readKeepingTheResult,
} from "./ReadKeepingTheResult.ts";

export type AfterTheVerdict = {
    readonly cleanup: readonly CleanupResult[] | undefined;
    readonly cleanupReviewItems: readonly RunReviewItem[];
    // Every record read after the steps, the origins the egress refused among them.
    readonly records: RecordsAfterTheSteps;
    readonly end: EndOfTheRun;
};

// Whether the run's end keeps a denial.
export const EndOfTheRunKind = {
    WithoutDenial: "without-denial",
    WithDenial: "with-denial",
} as const;

export type EndOfTheRunKind = (typeof EndOfTheRunKind)[keyof typeof EndOfTheRunKind];

// The state the run ends in, and the denial a denied run keeps. The one place a run's end is decided
// once every record is read: a run whose records leave it no verdict ends Errored, and a denied run
// keeps its denial whichever record went unread, since the guard did stop an action.
export type EndOfTheRun =
    | {
          readonly kind: typeof EndOfTheRunKind.WithoutDenial;
          readonly state:
              | typeof TerminalState.Passed
              | typeof TerminalState.Failed
              | typeof TerminalState.Errored;
      }
    | {
          readonly kind: typeof EndOfTheRunKind.WithDenial;
          readonly state: typeof TerminalState.Denied | typeof TerminalState.Errored;
          readonly denial: Denial;
      };

function endOfTheRun(finished: FinishedRun, records: RecordsAfterTheSteps): EndOfTheRun {
    const hasVerdict = !isVerdictLostToTheRecords(finished, records);
    if (finished.state === TerminalState.Denied) {
        return {
            kind: EndOfTheRunKind.WithDenial,
            state: hasVerdict ? TerminalState.Denied : TerminalState.Errored,
            denial: finished.denial,
        };
    }
    return {
        kind: EndOfTheRunKind.WithoutDenial,
        state: hasVerdict ? finished.state : TerminalState.Errored,
    };
}

// What the run's last part uses: the plan's cleanup and how it calls, what the closed session left,
// and the log.
type AfterTheVerdictContext = Pick<SessionContext, "cleared" | "calls" | "commands" | "logger"> & {
    readonly closed: ClosedSession;
};

export async function afterTheVerdict(
    context: AfterTheVerdictContext,
    verdict: StepsVerdict,
    readBeforeTheEgress: RecordsBeforeTheEgress,
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
    const blockedRead = readBlockedOrigins(context.closed);
    if (!blockedRead.ok) {
        logFailureAfterTheVerdict(
            RunReviewItemCode.EgressUnread,
            blockedRead.error,
            context.logger,
        );
    }
    const egress = blockedRead.ok ? recordRead(blockedRead.value) : RECORD_UNREAD;
    const records = { ...readBeforeTheEgress, egress };
    const end = endOfTheRun(verdict.finished, records);
    logTheEnd(context, readValueOr(egress, []), end);
    return { cleanup, cleanupReviewItems, records, end };
}

// The result claims what the egress refused and is hashed with that claim in it. So this is the one
// record read after the verdict that can't take an empty default: an empty list says nothing was
// refused, and when that isn't known the run has no verdict to give.
function readBlockedOrigins(closed: ClosedSession): Result<readonly string[], string> {
    const blocked = closed.blockedOrigins;
    return blocked.ok ? success([...new Set(blocked.value)].sort()) : blocked;
}

// The connections that failed, the origins the egress refused and the state the run ended in.
function logTheEnd(
    context: AfterTheVerdictContext,
    blocked: readonly string[],
    end: EndOfTheRun,
): void {
    const { closed, logger } = context;
    const connectionFailures = closedSessionRecord(closed.connectionFailures, logger);
    readKeepingTheResult(
        () => {
            for (const { origin, message } of readValueOr(connectionFailures, [])) {
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
                ...(end.kind === EndOfTheRunKind.WithDenial
                    ? { code: end.denial.rule, stepIndex: end.denial.stepIndex }
                    : {}),
            });
        },
        undefined,
        logger,
    );
}
