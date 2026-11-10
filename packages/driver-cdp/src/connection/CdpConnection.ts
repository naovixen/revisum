// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket. One socket carries
// every session ("flat" sessions, Target.attachToTarget with flatten: true); each command names
// the session it is for, or none for the browser itself. Every command has a timeout. Whatever the
// browser sends is decoded here, at the edge, before anyone else sees it.
import type { BrowserCommand } from "./BrowserCommand.ts";
import type { BrowserEvent } from "./BrowserEvent.ts";
import { CdpError, commandTimeoutText } from "./CdpError.ts";

export const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MILLISECONDS = 15_000;

// One session's view of the connection: commands and events for that session only.
export interface CdpSessionClient {
    // Sends a command and parses its reply before anyone sees it.
    ask<CommandParameters, Reply>(
        command: BrowserCommand<CommandParameters, Reply>,
        parameters: NoInfer<CommandParameters>,
        timeoutMilliseconds?: number,
    ): Promise<Reply>;
    // Calls handler for every well-formed event, and onMalformed, with where it is malformed, for any other.
    listen<Payload>(
        event: BrowserEvent<Payload>,
        handler: (payload: Payload) => void,
        onMalformed: (detail: string) => void,
    ): () => void;
}

type PendingCommand = {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    method: string;
};
export type ConnectOptions = {
    readonly connectTimeoutMilliseconds?: number;
    readonly commandTimeoutMilliseconds?: number;
};

// What arrives on the socket: the answer to a command, or an event of a session or of the browser.
type BrowserMessage =
    | {
          readonly kind: "reply";
          readonly id: number;
          readonly result: unknown;
          readonly errorMessage: string | undefined;
      }
    | {
          readonly kind: "event";
          readonly method: string;
          readonly parameters: unknown;
          readonly sessionId: string | undefined;
      };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

function errorMessageOf(error: unknown): string | undefined {
    if (error === undefined) {
        return undefined;
    }
    return isRecord(error) && typeof error["message"] === "string"
        ? error["message"]
        : "the browser answered with an unreadable error";
}

function parseFields(raw: string): Readonly<Record<string, unknown>> | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// What the socket carried, or null for something that is no message of the protocol.
function parseMessage(raw: string): BrowserMessage | null {
    const fields = parseFields(raw);
    if (fields === null) {
        return null;
    }
    const { id, method, sessionId, params, result, error } = fields;
    if (typeof id === "number") {
        return { kind: "reply", id, result, errorMessage: errorMessageOf(error) };
    }
    if (typeof method === "string" && (sessionId === undefined || typeof sessionId === "string")) {
        return { kind: "event", method, parameters: params, sessionId };
    }
    return null;
}

const listenerKey = (sessionId: string | undefined, event: string): string =>
    `${sessionId ?? ""}|${event}`;

const closeQuietly = (socket: WebSocket): void => {
    try {
        socket.close();
    } catch {
        // Already closed.
    }
};

export class CdpConnection {
    readonly #socket: WebSocket;
    readonly #commandTimeoutMilliseconds: number;
    #nextId = 1;
    readonly #pending = new Map<number, PendingCommand>();
    readonly #listeners = new Map<string, Set<(parameters: unknown) => void>>();
    readonly #lostHandlers = new Set<() => void>();
    #closed = false;

    // Made by open, once the socket is open.
    constructor(socket: WebSocket, commandTimeoutMilliseconds: number) {
        this.#socket = socket;
        this.#commandTimeoutMilliseconds = commandTimeoutMilliseconds;
        socket.addEventListener("message", (event: MessageEvent) => {
            this.#receive(String(event.data));
        });
        socket.addEventListener("close", () => {
            this.#failAll("connection closed");
        });
    }

    static open(url: string, options: ConnectOptions = {}): Promise<CdpConnection> {
        const connectTimeout =
            options.connectTimeoutMilliseconds ?? DEFAULT_CONNECT_TIMEOUT_MILLISECONDS;
        const commandTimeout =
            options.commandTimeoutMilliseconds ?? DEFAULT_COMMAND_TIMEOUT_MILLISECONDS;
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(url);
            const timer = setTimeout(() => {
                reject(new Error(`CDP connect timed out after ${connectTimeout} ms`));
                closeQuietly(socket);
            }, connectTimeout);
            socket.addEventListener(
                "open",
                () => {
                    clearTimeout(timer);
                    resolve(new CdpConnection(socket, commandTimeout));
                },
                { once: true },
            );
            socket.addEventListener(
                "error",
                () => {
                    clearTimeout(timer);
                    reject(new Error("CDP connect error"));
                },
                { once: true },
            );
        });
    }

    // Sends one command to a session (or to the browser when sessionId is undefined), and parses its
    // answer before anyone sees it. Rejects with CdpError, or with MalformedBrowserReply.
    async ask<CommandParameters, Reply>(
        sessionId: string | undefined,
        command: BrowserCommand<CommandParameters, Reply>,
        parameters: NoInfer<CommandParameters>,
        timeoutMilliseconds: number = this.#commandTimeoutMilliseconds,
    ): Promise<Reply> {
        return command.decode(
            await this.#sendForAnswer(sessionId, command.method, parameters, timeoutMilliseconds),
        );
    }

    #sendForAnswer(
        sessionId: string | undefined,
        method: string,
        parameters: unknown,
        timeoutMilliseconds: number,
    ): Promise<unknown> {
        if (this.#closed) {
            return Promise.reject(new CdpError(method, "connection closed"));
        }
        const id = this.#nextId++;
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new CdpError(method, commandTimeoutText(timeoutMilliseconds)));
            }, timeoutMilliseconds);
            this.#pending.set(id, { resolve, reject, timer, method });
            this.#socket.send(
                JSON.stringify({
                    id,
                    method,
                    params: parameters,
                    ...(sessionId === undefined ? {} : { sessionId }),
                }),
            );
        });
    }

    // Calls handler for every `event` of one session, parsed first, until the returned function is
    // called: a handler sees only a well-formed one, and nothing is thrown out of the socket's own
    // handler. onMalformed is told where any other is malformed.
    listen<Payload>(
        sessionId: string | undefined,
        event: BrowserEvent<Payload>,
        handler: (payload: Payload) => void,
        onMalformed: (detail: string) => void,
    ): () => void {
        const key = listenerKey(sessionId, event.name);
        let handlers = this.#listeners.get(key);
        if (handlers === undefined) {
            handlers = new Set();
            this.#listeners.set(key, handlers);
        }
        const registered = handlers;
        const decodeThenHandle = (parameters: unknown): void => {
            const decoded = event.decode(parameters);
            if (decoded.ok) {
                handler(decoded.value);
            } else {
                onMalformed(decoded.error);
            }
        };
        registered.add(decodeThenHandle);
        return () => {
            registered.delete(decodeThenHandle);
        };
    }

    // Calls handler if the connection closes before expectClose: the browser died or the socket
    // dropped. Stops when the returned function is called.
    onLost(handler: () => void): () => void {
        this.#lostHandlers.add(handler);
        return () => {
            this.#lostHandlers.delete(handler);
        };
    }

    // From now on the connection closing is the caller's doing, so nothing counts it as lost.
    expectClose(): void {
        this.#lostHandlers.clear();
    }

    session(sessionId: string | undefined): CdpSessionClient {
        return {
            ask: (command, parameters, timeoutMilliseconds) =>
                this.ask(sessionId, command, parameters, timeoutMilliseconds),
            listen: (event, handler, onMalformed) =>
                this.listen(sessionId, event, handler, onMalformed),
        };
    }

    close(): void {
        this.expectClose();
        this.#closed = true;
        closeQuietly(this.#socket);
    }

    #receive(raw: string): void {
        const message = parseMessage(raw);
        if (message === null) {
            // Nothing that follows on this socket can be trusted to be what it seems.
            this.#failAll("the browser sent something that is no message of the protocol");
            closeQuietly(this.#socket);
            return;
        }
        if (message.kind === "event") {
            const handlers = this.#listeners.get(listenerKey(message.sessionId, message.method));
            for (const handler of handlers ?? []) {
                handler(message.parameters);
            }
            return;
        }
        const command = this.#pending.get(message.id);
        if (command === undefined) {
            return;
        }
        this.#pending.delete(message.id);
        clearTimeout(command.timer);
        if (message.errorMessage === undefined) {
            command.resolve(message.result);
        } else {
            command.reject(new CdpError(command.method, message.errorMessage));
        }
    }

    #failAll(reason: string): void {
        this.#closed = true;
        // Told before any command fails, so whoever sees a failed command already knows why.
        for (const handler of [...this.#lostHandlers]) {
            handler();
        }
        for (const command of this.#pending.values()) {
            clearTimeout(command.timer);
            command.reject(new CdpError(command.method, reason));
        }
        this.#pending.clear();
    }
}
