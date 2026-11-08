// How long a session waits for a page, and for input it sends. A command is sent once; waiting is
// re-reading under one deadline.
import type { DriverError } from "@revisum/contracts";
import type { HasStepEnded } from "../page/PageOperations.ts";

export const TIMED_OUT = Symbol("timed out");
export const POLL_INTERVAL_MILLISECONDS = 50;
// However late an element was found, its input gets this long, or the input could never be seen to
// land. So a step ends within about its timeout and this, never twice its timeout.
export const SHORTEST_INPUT_MILLISECONDS = 1_000;

export const pause = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

export const notAnswering = (timeoutMilliseconds: number): DriverError => ({
    code: "timeout",
    detail: `the page did not answer within ${timeoutMilliseconds} ms`,
});

// What a read of a step throws when the page has not answered by the step's deadline, for the step's
// own catch to say what became of it.
export class StepOutOfTime extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StepOutOfTime";
    }
}

// Waits for what the page was asked for at most this long. While a navigation of the page waits for
// its server, the browser answers no command to that page, and nor does the mouse release that began
// it, so a server that holds its answer would otherwise hold the step for as long as a command's own
// limit, however short the step's timeout. What was asked for is left to end by itself.
export async function forAtMost<Value>(
    milliseconds: number,
    work: Promise<Value>,
): Promise<Value | typeof TIMED_OUT> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<typeof TIMED_OUT>((resolveTimedOut) => {
        timer = setTimeout(() => resolveTimedOut(TIMED_OUT), milliseconds);
    });
    try {
        return await Promise.race([work, timedOut]);
    } finally {
        clearTimeout(timer);
    }
}

// Sends input for at most this long. The input is told the time has run out as the timer fires, and
// then sends nothing more: what it had yet to send would reach the page during the failure's capture
// or a later step, as input the plan never asked for there.
export async function inputForAtMost<Value>(
    milliseconds: number,
    send: (hasStepEnded: HasStepEnded) => Promise<Value>,
): Promise<Value | typeof TIMED_OUT> {
    let hasStepEnded = false;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<typeof TIMED_OUT>((resolveTimedOut) => {
        timer = setTimeout(() => {
            hasStepEnded = true;
            resolveTimedOut(TIMED_OUT);
        }, milliseconds);
    });
    try {
        return await Promise.race([send(() => hasStepEnded), timedOut]);
    } finally {
        clearTimeout(timer);
    }
}
