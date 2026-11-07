// Waiting by looking again: one look after another until one is done or the time runs out.
import type { Clock } from "@revisum/contracts";

// When a wait stops: how long it may go on, how long it waits between two looks, and which look
// ends it early.
export type PollRule<Look> = {
    readonly timeoutMilliseconds: number;
    readonly intervalMilliseconds: number;
    readonly isDone: (look: Look) => boolean;
};

// Looks until a look is done or the timeout has run out, and gives the last look. Each look is told
// its attempt, counted from 1, for the records that count them. The deadline is set before the
// first look, and the clock is read again only after a look that is not done.
export async function pollUntil<Look>(
    clock: Clock,
    rule: PollRule<Look>,
    look: (attempt: number) => Promise<Look>,
): Promise<Look> {
    const deadline = clock.now() + rule.timeoutMilliseconds;
    for (let attempt = 1; ; attempt++) {
        const seen = await look(attempt);
        if (rule.isDone(seen) || clock.now() >= deadline) {
            return seen;
        }
        await clock.sleep(rule.intervalMilliseconds);
    }
}

// A look that carries what the step ends with if it is the last, and whether no later look may
// change it.
export type JudgedLook<Outcome> = { readonly outcome: Outcome; readonly isDone: boolean };

export const isJudgedLookDone = (look: JudgedLook<unknown>): boolean => look.isDone;
