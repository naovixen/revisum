// A command the browser answered with an error, or a command that never got an answer.
export class CdpError extends Error {
    readonly method: string;
    constructor(method: string, message: string) {
        super(`${method}: ${message}`);
        this.method = method;
    }
}
