// A minimal Chrome DevTools Protocol client over Node's built-in WebSocket. One socket carries
// every session ("flat" sessions, Target.attachToTarget with flatten: true); each command names
// the session it is for, or none for the browser itself. Every command has a timeout.
// See docs/specs/SPEC-06-cdp-driver.md.

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
  send<Value = unknown>(method: string, parameters?: Record<string, unknown>, timeoutMilliseconds?: number): Promise<Value>;
  on(event: string, handler: (parameters: unknown) => void): () => void;
}

type PendingCommand = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; method: string };
type Message = {
  id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string }; sessionId?: string;
};
export type ConnectOptions = { readonly connectTimeoutMilliseconds?: number; readonly commandTimeoutMilliseconds?: number };

export class CdpConnection {
  private readonly socket: WebSocket;
  private readonly commandTimeoutMilliseconds: number;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCommand>();
  private readonly listeners = new Map<string, Set<(parameters: unknown) => void>>();
  private closed = false;

  private constructor(socket: WebSocket, commandTimeoutMilliseconds: number) {
    this.socket = socket;
    this.commandTimeoutMilliseconds = commandTimeoutMilliseconds;
    socket.addEventListener('message', (event: MessageEvent) => this.receive(String(event.data)));
    socket.addEventListener('close', () => this.failAll('connection closed'));
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

  // Sends one command to a session (or to the browser when sessionId is undefined) and waits for
  // its answer, failing after timeoutMilliseconds.
  send<Value = unknown>(
    sessionId: string | undefined, method: string, parameters: Record<string, unknown> = {},
    timeoutMilliseconds: number = this.commandTimeoutMilliseconds,
  ): Promise<Value> {
    if (this.closed) return Promise.reject(new CdpError(method, 'connection closed'));
    const id = this.nextId++;
    return new Promise<Value>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(method, `timeout after ${timeoutMilliseconds} ms`));
      }, timeoutMilliseconds);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer, method });
      const message: Message & { params: Record<string, unknown> } = { id, method, params: parameters };
      if (sessionId !== undefined) message.sessionId = sessionId;
      this.socket.send(JSON.stringify(message));
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

  session(sessionId: string | undefined): CdpSessionClient {
    return {
      send: <Value = unknown>(method: string, parameters?: Record<string, unknown>, timeoutMilliseconds?: number) =>
        this.send<Value>(sessionId, method, parameters ?? {}, timeoutMilliseconds ?? this.commandTimeoutMilliseconds),
      on: (event, handler) => this.on(sessionId, event, handler),
    };
  }

  close(): void {
    this.closed = true;
    try { this.socket.close(); } catch { /* already closed */ }
  }

  private receive(raw: string): void {
    const message = JSON.parse(raw) as Message;
    if (message.id !== undefined) {
      const command = this.pending.get(message.id);
      if (command === undefined) return;
      this.pending.delete(message.id);
      clearTimeout(command.timer);
      if (message.error) command.reject(new CdpError(command.method, message.error.message));
      else command.resolve(message.result);
      return;
    }
    if (message.method !== undefined) {
      for (const handler of this.listeners.get(listenerKey(message.sessionId, message.method)) ?? []) handler(message.params);
    }
  }

  private failAll(reason: string): void {
    this.closed = true;
    for (const command of this.pending.values()) {
      clearTimeout(command.timer);
      command.reject(new CdpError(command.method, reason));
    }
    this.pending.clear();
  }
}

const listenerKey = (sessionId: string | undefined, event: string): string => `${sessionId ?? ''}|${event}`;
