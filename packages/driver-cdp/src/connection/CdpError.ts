// A command the browser answered with an error, or a command that never got an answer.
export class CdpError extends Error {
    readonly method: string;
    constructor(method: string, message: string) {
        super(`${method}: ${message}`);
        this.method = method;
    }
}

// What a command fails with when no answer comes in time.
export const commandTimeoutText = (timeoutMilliseconds: number): string =>
    `timeout after ${timeoutMilliseconds} ms`;

const COMMAND_TIMEOUT = /timeout after \d+ ms/;

// True when a command ended because no answer came in time.
export const isCommandTimeout = (error: unknown): boolean =>
    error instanceof CdpError && COMMAND_TIMEOUT.test(error.message);
