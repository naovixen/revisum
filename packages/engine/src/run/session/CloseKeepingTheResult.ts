// Closing the session once the steps have a verdict, without letting the close change it.
import { failure, type Clock, type ClosedSession, type Session } from "@revisum/contracts";
import type { Logger } from "../../logging.ts";
import { errorText } from "../CodeForThrow.ts";
import {
    FailureAfterTheVerdictCode,
    logFailureAfterTheVerdict,
} from "../after-the-verdict/ReadKeepingTheResult.ts";
import { POLL_INTERVAL_MILLISECONDS } from "../Poll.ts";

// Longer than a driver's stop takes to give up by itself, so this deadline is only for what has wedged.
const LONGEST_SESSION_CLOSE_MILLISECONDS = 60_000;

// A session that will not close, such as a browser profile Windows still holds, says nothing about
// what the steps found. It stays out of the result, whose hash a replay on a calmer machine must match.
// Nor does one that never answers hold the result back. Whatever comes of it after that goes unlogged, so
// the failure is logged once. Gives what the closed session left, or, when it did not close in time
// or, against its port, rejected, what the session had noted by then.
export async function closeKeepingTheResult(
    session: Session,
    clock: Clock,
    logger: Logger,
): Promise<ClosedSession> {
    const progress: {
        hasEnded: boolean;
        hasStoppedWaiting: boolean;
        closed: ClosedSession | null;
    } = {
        hasEnded: false,
        hasStoppedWaiting: false,
        closed: null,
    };
    const closing = (async () => {
        try {
            const closed = await session.close();
            if (closed.closeFailure !== null && !progress.hasStoppedWaiting) {
                logFailureAfterTheVerdict(
                    FailureAfterTheVerdictCode.SessionCloseFailed,
                    closed.closeFailure,
                    logger,
                );
            }
            progress.closed = closed;
        } catch (error) {
            if (!progress.hasStoppedWaiting) {
                logFailureAfterTheVerdict(
                    FailureAfterTheVerdictCode.SessionCloseFailed,
                    error,
                    logger,
                );
            }
        } finally {
            progress.hasEnded = true;
        }
    })();
    try {
        // A close with nothing to wait for has ended after one turn, which takes nothing from the clock.
        await Promise.race([closing, clock.sleep(0)]);
        const deadline = clock.now() + LONGEST_SESSION_CLOSE_MILLISECONDS;
        while (!progress.hasEnded) {
            if (clock.now() >= deadline) {
                progress.hasStoppedWaiting = true;
                logFailureAfterTheVerdict(
                    FailureAfterTheVerdictCode.SessionCloseFailed,
                    `the session did not close within ${LONGEST_SESSION_CLOSE_MILLISECONDS} ms`,
                    logger,
                );
                return recordsWithoutAClose(session, "the session did not close in time");
            }
            await Promise.race([closing, clock.sleep(POLL_INTERVAL_MILLISECONDS)]);
        }
        return progress.closed ?? recordsWithoutAClose(session, "the session did not close");
    } catch (error) {
        // Only the clock can have failed, and with no clock there is no deadline to wait for the close by.
        if (!progress.hasEnded) {
            progress.hasStoppedWaiting = true;
            logFailureAfterTheVerdict(FailureAfterTheVerdictCode.SessionCloseFailed, error, logger);
        }
        return progress.closed ?? recordsWithoutAClose(session, errorText(error));
    }
}

// What the session had noted when its close did not give a record. A session that cannot say that
// either still ends with a record, and each of its parts says why it could not be read.
function recordsWithoutAClose(session: Session, closeFailure: string): ClosedSession {
    try {
        return { ...session.recordsSoFar(), closeFailure };
    } catch (error) {
        const unread = failure(errorText(error));
        return {
            blockedOrigins: unread,
            connectionFailures: unread,
            refusedRequestDecisions: unread,
            closeFailure,
        };
    }
}
