// How long a target has to give an open connection, for every client: its name's lookup and the walk
// across its addresses together. A deadline per address would let a name with many silent addresses
// hold a request open for many times this.
const CONNECT_LIMIT_MILLISECONDS = 30_000;

export type ConnectDeadline = {
    // Aborts when the limit passes or whoever asked has gone.
    readonly ended: AbortSignal;
    // Why it ended. Only meaningful once it has.
    readonly failure: () => Error;
    // How much of the limit is left, never below zero.
    readonly millisecondsLeft: () => number;
    // Gives up the timer, once the waiting is over.
    readonly stop: () => void;
};

export function startConnectDeadline(abandoned: AbortSignal): ConnectDeadline {
    const controller = new AbortController();
    const endsAt = Date.now() + CONNECT_LIMIT_MILLISECONDS;
    let reason = new Error("the client left before a connection opened");
    const onAbandoned = (): void => {
        controller.abort();
    };
    const timer = setTimeout(() => {
        reason = new Error(`no connection opened within ${CONNECT_LIMIT_MILLISECONDS} ms`);
        controller.abort();
    }, CONNECT_LIMIT_MILLISECONDS);
    if (abandoned.aborted) {
        onAbandoned();
    } else {
        abandoned.addEventListener("abort", onAbandoned, { once: true });
    }
    return {
        ended: controller.signal,
        failure: () => reason,
        millisecondsLeft: () => Math.max(0, endsAt - Date.now()),
        stop: () => {
            clearTimeout(timer);
            abandoned.removeEventListener("abort", onAbandoned);
        },
    };
}
