// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket. One socket carries
// every session ("flat" sessions, Target.attachToTarget with flatten: true); each command names
// the session it is for, or none for the browser itself. Every command has a timeout.
import type { BrowserCommand } from './BrowserCommand.ts';
import type { BrowserEvent } from './BrowserEvent.ts';

export const DEFAULT_COMMAND_TIMEOUT_MILLISECONDS = 15_000;
const DEFAULT_CONNECT_TIMEOUT_MILLISECONDS = 15_000;

// A command the browser answered with an error, or a command that never got an answer.
export class CdpError extends Error {
  readonly method: string;
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.method = method;
  }
}

// One session's view of the connection: commands and events for that session only.
export interface CdpSessionClient {
  // Sends a command and parses its reply before anyone sees it.
  ask<CommandParameters, Reply>(command: BrowserCommand<CommandParameters, Reply>, parameters: NoInfer<CommandParameters>, timeoutMilliseconds?: number): Promise<Reply>;
  // Calls handler for every well-formed event, and onMalformed, with where it is malformed, for any other.
  listen<Payload>(event: BrowserEvent<Payload>, handler: (payload: Payload) => void, onMalformed: (detail: string) => void): () => void;
  // For tests, which send what no command here describes.
  send<Value = unknown>(method: string, parameters?: Record<string, unknown>, timeoutMilliseconds?: number): Promise<Value>;
  on(event: string, handler: (parameters: unknown) => void): () => void;
}

type PendingCommand = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string };
export type ConnectOptions = { readonly connectTimeoutMilliseconds?: number; readonly commandTimeoutMilliseconds?: number };

// What arrives on the socket: the answer to a command, or an event of a session or of the browser.
type BrowserMessage =
  | { readonly kind: 'reply'; readonly id: number; readonly result: unknown; readonly errorMessage: string | undefined }
  | { readonly kind: 'event'; readonly method: string; readonly parameters: unknown; readonly sessionId: string | undefined };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);

function errorMessageOf(error: unknown): string | undefined {
  if (error === undefined) {
    return undefined;
  }
  return isRecord(error) && typeof error['message'] === 'string' ? error['message'] : 'the browser answered with an unreadable error';
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
  if (typeof id === 'number') {
    return { kind: 'reply', id, result, errorMessage: errorMessageOf(error) };
  }
  if (typeof method === 'string' && (sessionId === undefined || typeof sessionId === 'string')) {
    return { kind: 'event', method, parameters: params, sessionId };
  }
  return null;
}

export class CdpConnection {
  private readonly socket: WebSocket;
  private readonly commandTimeoutMilliseconds: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<(parameters: unknown) => void>>();
  readonly #lostHandlers = new Set<() => void>();
  private closed = false;

  private constructor(socket: WebSocket, commandTimeoutMilliseconds: number) {
    this.socket = socket;
    this.commandTimeoutMilliseconds = commandTimeoutMilliseconds;
    socket.addEventListener('message', (event: MessageEvent) => { this.receive(String(event.data)); });
    socket.addEventListener('close', () => { this.failAll('connection closed'); });
  }

  static open(url: string, options: ConnectOptions = {}): Promise<CdpConnection> {
    const connectTimeout = options.connectTimeoutMilliseconds ?? DEFAULT_CONNECT_TIMEOUT_MILLISECONDS;
    const commandTimeout = options.commandTimeoutMilliseconds ?? DEFAULT_COMMAND_TIMEOUT_MILLISECONDS;
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        reject(new Error(`CDP connect timed out after ${connectTimeout} ms`));
        try { socket.close(); } catch { /* already closed */ }
      }, connectTimeout);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpConnection(socket, commandTimeout)); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connect error')); }, { once: true });
    });
  }

  // Sends one command to a session (or to the browser when sessionId is undefined), and parses its
  // answer before anyone sees it. Rejects with CdpError, or with MalformedBrowserReply.
  async ask<CommandParameters, Reply>(
    sessionId: string | undefined, command: BrowserCommand<CommandParameters, Reply>, parameters: NoInfer<CommandParameters>,
    timeoutMilliseconds: number = this.commandTimeoutMilliseconds,
  ): Promise<Reply> {
    return command.decode(await this.#sendForAnswer(sessionId, command.method, parameters, timeoutMilliseconds));
  }

  // For tests, which send what no command here describes. The driver itself goes through ask.
  send<Value = unknown>(
    sessionId: string | undefined, method: string, parameters: Record<string, unknown> = {},
    timeoutMilliseconds: number = this.commandTimeoutMilliseconds,
  ): Promise<Value> {
    return this.#sendForAnswer(sessionId, method, parameters, timeoutMilliseconds) as Promise<Value>;
  }

  #sendForAnswer(sessionId: string | undefined, method: string, parameters: unknown, timeoutMilliseconds: number): Promise<unknown> {
    if (this.closed) return Promise.reject(new CdpError(method, 'connection closed'));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, `timeout after ${timeoutMilliseconds} ms`));
      }, timeoutMilliseconds);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params: parameters, ...(sessionId === undefined ? {} : { sessionId }) }));
    });
  }

  // Calls handler for every `event` of one session until the returned function is called.
  on(sessionId: string | undefined, event: string, handler: (parameters: unknown) => void): () => void {
    const key = listenerKey(sessionId, event);
    let handlers = this.listeners.get(key);
    if (handlers === undefined) {
      handlers = new Set();
      this.listeners.set(key, handlers);
    }
    const registered = handlers;
    registered.add(handler);
    return () => { registered.delete(handler); };
  }

  // As on, with the event parsed first: a handler sees only a well-formed one, and nothing is thrown
  // out of the socket's own handler. onMalformed is told where any other is malformed.
  listen<Payload>(
    sessionId: string | undefined, event: BrowserEvent<Payload>, handler: (payload: Payload) => void, onMalformed: (detail: string) => void,
  ): () => void {
    return this.on(sessionId, event.name, (parameters) => {
      const decoded = event.decode(parameters);
      if (decoded.ok) {
        handler(decoded.value);
      } else {
        onMalformed(decoded.error);
      }
    });
  }

  // Resolves on the next `event` of one session, or rejects after timeoutMilliseconds.
  once(sessionId: string, event: string, timeoutMilliseconds: number): { readonly promise: Promise<unknown>; cancel(): void } {
    let stopListening = (): void => {};
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<unknown>((resolve, reject) => {
      stopListening = this.on(sessionId, event, (parameters) => { clearTimeout(timer); stopListening(); resolve(parameters); });
      timer = setTimeout(() => { stopListening(); reject(new CdpError(event, `timeout after ${timeoutMilliseconds} ms`)); }, timeoutMilliseconds);
    });
    return { promise, cancel: () => { clearTimeout(timer); stopListening(); } };
  }

  // Calls handler if the connection closes before expectClose: the browser died or the socket
  // dropped. Stops when the returned function is called.
  onLost(handler: () => void): () => void {
    this.#lostHandlers.add(handler);
    return () => { this.#lostHandlers.delete(handler); };
  }

  // From now on the connection closing is the caller's doing, so nothing counts it as lost.
  expectClose(): void {
    this.#lostHandlers.clear();
  }

  session(sessionId: string | undefined): CdpSessionClient {
    return {
      ask: (command, parameters, timeoutMilliseconds) => this.ask(sessionId, command, parameters, timeoutMilliseconds),
      listen: (event, handler, onMalformed) => this.listen(sessionId, event, handler, onMalformed),
      send: <Value = unknown>(method: string, parameters?: Record<string, unknown>, timeoutMilliseconds?: number) =>
        this.send<Value>(sessionId, method, parameters ?? {}, timeoutMilliseconds ?? this.commandTimeoutMilliseconds),
      on: (event, handler) => this.on(sessionId, event, handler),
    };
  }

  close(): void {
    this.expectClose();
    this.closed = true;
    try { this.socket.close(); } catch { /* already closed */ }
  }

  private receive(raw: string): void {
    const message = parseMessage(raw);
    if (message === null) {
      // Nothing that follows on this socket can be trusted to be what it seems.
      this.failAll('the browser sent something that is no message of the protocol');
      try { this.socket.close(); } catch { /* already closed */ }
      return;
    }
    if (message.kind === 'event') {
      for (const handler of this.listeners.get(listenerKey(message.sessionId, message.method)) ?? []) handler(message.parameters);
      return;
    }
    const command = this.pending.get(message.id);
    if (command === undefined) return;
    this.pending.delete(message.id);
    clearTimeout(command.timer);
    if (message.errorMessage === undefined) {
      command.resolve(message.result);
    } else {
      command.reject(new CdpError(command.method, message.errorMessage));
    }
  }

  private failAll(reason: string): void {
    this.closed = true;
    // Told before any command fails, so whoever sees a failed command already knows why.
    for (const handler of [...this.#lostHandlers]) {
      handler();
    }
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(new CdpError(command.method, reason));
    }
    this.pending.clear();
  }
}

const listenerKey = (sessionId: string | undefined, event: string): string => `${sessionId ?? ''}|${event}`;
