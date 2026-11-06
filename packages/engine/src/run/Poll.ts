// Waiting on the page: a check repeated until it passes or the step timeout runs out.
import {
    StepCode,
    UnreadablePage,
    type DocumentSession,
    type PageReadFailure,
} from "@revisum/contracts";
import type { Logger } from "../logging.ts";
import type { Verdict } from "../oracle.ts";
import { codeOfFailedRead } from "./CodeForThrow.ts";
import type { RunContext } from "./RunContext.ts";

// How long a check waits between two looks at the page.
export const POLL_INTERVAL_MILLISECONDS = 50;

// A check the page stopped rather than answered: its renderer died while the check waited, or a read
// of it failed for a reason that is the adapter's. What the check last saw then says nothing about the
// page, so the step fails with this code and keeps no observation. Every other failed verdict is the
// check's own answer, which the step fails with, keeping what it saw where the step has an observation.
type CheckStopped = {
    readonly pass: false;
    readonly code: typeof StepCode.TargetCrashed | typeof StepCode.AdapterError;
};
export type PollVerdict = Verdict | CheckStopped;

export const isCheckStopped = (verdict: PollVerdict): verdict is CheckStopped =>
    verdict.code === StepCode.TargetCrashed || verdict.code === StepCode.AdapterError;

export const verdictOfFailedRead = (readFailure: PageReadFailure, logger: Logger): PollVerdict => ({
    pass: false,
    code: codeOfFailedRead(readFailure, logger),
});

// True when waiting cannot change the verdict: a selector the browser rejects, a dialog, which only a
// later step can answer, the browser's own error page, which runs no script that could leave it, or a
// read that failed.
const isFinal = (verdict: PollVerdict): boolean =>
    verdict.pass ||
    isCheckStopped(verdict) ||
    verdict.code === StepCode.SelectorInvalid ||
    verdict.code === UnreadablePage.DialogOpen ||
    verdict.code === StepCode.NavigationFailed;

// Repeats a check until it passes or the step timeout runs out. A page that crashes stops the
// wait at once: nothing on it can change any more, and the same goes for a read of the page that failed.
export async function poll(
    context: RunContext,
    document: DocumentSession,
    check: () => Promise<PollVerdict>,
): Promise<PollVerdict> {
    const deadline =
        context.ports.clock.now() + context.cleared.project.limits.stepTimeoutMilliseconds;
    for (;;) {
        const verdict = await check();
        // Looked at before a pass is accepted: what a dying page last showed proves nothing. A probe has no
        // count for a crash either, so one that read nothing on a dead page is told apart here.
        if (document.crashed()) {
            return { pass: false, code: StepCode.TargetCrashed };
        }
        if (isFinal(verdict) || context.ports.clock.now() >= deadline) {
            return verdict;
        }
        await context.ports.clock.sleep(POLL_INTERVAL_MILLISECONDS);
    }
}
