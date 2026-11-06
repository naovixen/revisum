// Clock advances and clipboard checks, which the session's clock and clipboard ports carry out.
import {
    advanceClock,
    checkClipboard,
    type ClockAndClipboardContext,
} from "../../../clock-and-clipboard-steps.ts";
import type { SessionContext, StepExecutorTable } from "../StepExecutor.ts";

// What the clock and clipboard steps use: the run's session and values.
export const clockAndClipboardContext = (context: SessionContext): ClockAndClipboardContext => ({
    project: context.cleared.project,
    session: context.session,
    values: context.values,
    remembered: context.remembered,
    clock: context.ports.clock,
});

export const CLOCK_AND_CLIPBOARD_EXECUTORS: Pick<
    StepExecutorTable,
    "advanceClock" | "expectClipboard"
> = {
    advanceClock: (step, context) => advanceClock(step, clockAndClipboardContext(context)),
    expectClipboard: (step, context) => checkClipboard(step, clockAndClipboardContext(context)),
};
