// Closing the session once the steps have a verdict, without letting the close change it.
import type { Clock, Session } from "@revisum/contracts";
import type { Logger } from "../../logging.ts";
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
// the failure is logged once.
export async function closeKeepingTheResult(
    session: Session,
    clock: Clock,
    logger: Logger,
): Promise<void> {
    const progress = { hasEnded: false, hasStoppedWaiting: false };
    const closing = (async () => {
        try {
            await session.close();
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
                return;
            }
            await Promise.race([closing, clock.sleep(POLL_INTERVAL_MILLISECONDS)]);
        }
    } catch (error) {
        // Only the clock can have failed, and with no clock there is no deadline to wait for the close by.
        if (!progress.hasEnded) {
            progress.hasStoppedWaiting = true;
            logFailureAfterTheVerdict(FailureAfterTheVerdictCode.SessionCloseFailed, error, logger);
        }
    }
}
