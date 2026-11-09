// Closing the session once the steps have a verdict, without letting the close change it.
import type { Clock, ClosedSession, Session } from "@revisum/contracts";
import type { Logger } from "../logging/LoggingManifest.ts";
import { recordsWithoutAClose } from "../../target/GuardedDriver.ts";
import { errorText } from "../CodeForThrow.ts";
import {
    FailureAfterTheVerdictCode,
    logFailureAfterTheVerdict,
} from "../after-the-verdict/ReadKeepingTheResult.ts";
import { POLL_INTERVAL_MILLISECONDS } from "../PollUntil.ts";

// Longer than a driver's stop takes to give up by itself, so this deadline is only for what has wedged.
const LONGEST_SESSION_CLOSE_MILLISECONDS = 60_000;
// How many turns of the event loop a close with nothing to wait for may take, the driver's guard included.
const TURNS_OF_A_PROMPT_CLOSE = 4;

// A session that will not close, such as a browser profile Windows still holds, says nothing about
// what the steps found. It stays out of the result, whose hash a replay on a calmer machine must match.
// Nor does one that never answers hold the result back. Whatever comes of it after that goes unlogged, so
// the failure is logged once. Gives what the closed session left, or, when it did not close in time,
// what the session had noted by then. A session's close never rejects: the guarded driver sees to that.
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
        } finally {
            progress.hasEnded = true;
        }
    })();
    try {
        // A close with nothing to wait for has ended within a few turns, which take nothing from the clock.
        for (let turn = 0; turn < TURNS_OF_A_PROMPT_CLOSE && !progress.hasEnded; turn += 1) {
            await Promise.race([closing, clock.sleep(0)]);
        }
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
