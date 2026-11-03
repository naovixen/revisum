// Stands where a browser's debugging address would. It passes every message between a driver and a
// real browser, and changes only the replies a test names, so a test can see what the driver does
// with a reply it would rarely see from a healthy browser. Node has a WebSocket client built in but
// no server, so the little of the server's side this needs is written here.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

const HANDSHAKE_SUFFIX = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const TEXT_FRAME = 0x1;
const CLOSE_FRAME = 0x8;
const OPCODE_BITS = 0x0f;
const LENGTH_BITS = 0x7f;
const LAST_FRAGMENT_BIT = 0x80;
const MASK_BYTES = 4;
const LONGEST_SHORT_LENGTH = 125;
const TWO_BYTE_LENGTH = 126;
const EIGHT_BYTE_LENGTH = 127;
const LONGEST_TWO_BYTE_LENGTH = 0xffff;
const BROWSER_ERROR_CODE = -32000;

export type SentCommand = {
    readonly method: string;
    readonly parameters: Readonly<Record<string, unknown>>;
    // The address of the request a Fetch decision is about, once the browser has said it.
    readonly pausedUrl: string | null;
};

export type ReplyChange =
    // The browser never gets the command, and the driver hears that it refused, for this reason.
    | { readonly refusal: string }
    // The browser gets the command, and the driver hears this in its place. Undefined leaves the
    // reply with no result at all.
    | { readonly result: unknown };

export type ReplyTampering = {
    readonly method: string;
    readonly applies?: (command: SentCommand) => boolean;
    readonly change: ReplyChange;
};

export type CdpRelay = {
    readonly url: string;
    forwardTo(browserUrl: string): void;
    // Changes replies from now on, and starts the list of commands again.
    tamperWith(tampering: ReplyTampering): void;
    // Every command the driver sent since tampering began.
    commands(): readonly SentCommand[];
    timesTampered(): number;
    // Tells the driver of an event on its page's session, as if the browser had sent it.
    sendEvent(method: string, parameters: Readonly<Record<string, unknown>>): void;
    close(): Promise<void>;
};

type JsonObject = Readonly<Record<string, unknown>>;

const isJsonObject = (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const parsedMessage = (text: string): JsonObject => {
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed)) {
        throw new Error("a debugging message is not an object");
    }
    return parsed;
};

const textOf = (value: unknown): string | null => (typeof value === "string" ? value : null);

function frameOf(opcode: number, payload: Buffer): Buffer {
    const first = LAST_FRAGMENT_BIT | opcode;
    if (payload.length <= LONGEST_SHORT_LENGTH) {
        return Buffer.concat([Buffer.from([first, payload.length]), payload]);
    }
    if (payload.length <= LONGEST_TWO_BYTE_LENGTH) {
        const length = Buffer.alloc(2);
        length.writeUInt16BE(payload.length);
        return Buffer.concat([Buffer.from([first, TWO_BYTE_LENGTH]), length, payload]);
    }
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(payload.length));
    return Buffer.concat([Buffer.from([first, EIGHT_BYTE_LENGTH]), length, payload]);
}

type Frame = { readonly opcode: number; readonly payload: Buffer; readonly byteLength: number };

// The first whole frame a client sent, whose payload is always masked, or null until it has all come.
function firstFrame(received: Buffer): Frame | null {
    if (received.length < 2) {
        return null;
    }
    const opcode = received.readUInt8(0) & OPCODE_BITS;
    const shortLength = received.readUInt8(1) & LENGTH_BITS;
    let lengthBytes = 0;
    if (shortLength === TWO_BYTE_LENGTH) {
        lengthBytes = 2;
    } else if (shortLength === EIGHT_BYTE_LENGTH) {
        lengthBytes = 8;
    }
    const maskStart = 2 + lengthBytes;
    if (received.length < maskStart) {
        return null;
    }
    let payloadLength = shortLength;
    if (lengthBytes === 2) {
        payloadLength = received.readUInt16BE(2);
    } else if (lengthBytes === 8) {
        payloadLength = Number(received.readBigUInt64BE(2));
    }
    const payloadStart = maskStart + MASK_BYTES;
    const byteLength = payloadStart + payloadLength;
    if (received.length < byteLength) {
        return null;
    }
    const mask = received.subarray(maskStart, payloadStart);
    const payload = Buffer.from(received.subarray(payloadStart, byteLength));
    payload.forEach((byte, index) => {
        payload.writeUInt8(byte ^ mask.readUInt8(index % MASK_BYTES), index);
    });
    return { opcode, payload, byteLength };
}

const acceptKeyFor = (request: IncomingMessage): string =>
    createHash("sha1")
        .update(`${String(request.headers["sec-websocket-key"])}${HANDSHAKE_SUFFIX}`)
        .digest("base64");

// What every connection through one relay shares.
type RelayState = {
    browserUrl: string | null;
    tampering: ReplyTampering | null;
    commands: SentCommand[];
    timesTampered: number;
    lastSessionId: string | null;
    readonly pausedUrls: Map<string, string>;
    readonly sockets: Set<Duplex>;
    readonly upstreams: Set<WebSocket>;
};

const commandFrom = (state: RelayState, message: JsonObject): SentCommand => {
    const parameters = isJsonObject(message["params"]) ? message["params"] : {};
    const requestId = textOf(parameters["requestId"]);
    return {
        method: textOf(message["method"]) ?? "",
        parameters,
        pausedUrl: requestId === null ? null : (state.pausedUrls.get(requestId) ?? null),
    };
};

const noteAnythingPaused = (state: RelayState, message: JsonObject): void => {
    const parameters = message["params"];
    if (message["method"] !== "Fetch.requestPaused" || !isJsonObject(parameters)) {
        return;
    }
    const request = parameters["request"];
    const requestId = textOf(parameters["requestId"]);
    if (requestId !== null && isJsonObject(request)) {
        state.pausedUrls.set(requestId, textOf(request["url"]) ?? "");
    }
};

const changeFor = (state: RelayState, command: SentCommand): ReplyChange | null => {
    const { tampering } = state;
    if (tampering === null || tampering.method !== command.method) {
        return null;
    }
    return (tampering.applies?.(command) ?? true) ? tampering.change : null;
};

const writeText = (socket: Duplex, text: string): void => {
    socket.write(frameOf(TEXT_FRAME, Buffer.from(text)));
};

function relayConnection(state: RelayState, socket: Duplex, upstream: WebSocket): void {
    const replacedResults = new Map<unknown, { readonly result: unknown }>();
    let received = Buffer.alloc(0);

    const onCommand = (text: string): void => {
        const message = parsedMessage(text);
        const command = commandFrom(state, message);
        const { id, sessionId } = message;
        state.lastSessionId = textOf(sessionId) ?? state.lastSessionId;
        state.commands.push(command);
        const change = changeFor(state, command);
        if (change !== null) {
            state.timesTampered += 1;
            if ("refusal" in change) {
                const error = { code: BROWSER_ERROR_CODE, message: change.refusal };
                writeText(socket, JSON.stringify({ id, sessionId, error }));
                return;
            }
            replacedResults.set(id, change);
        }
        upstream.send(text);
    };

    upstream.addEventListener("message", (event: MessageEvent) => {
        const text = String(event.data);
        const message = parsedMessage(text);
        noteAnythingPaused(state, message);
        const replaced = replacedResults.get(message["id"]);
        replacedResults.delete(message["id"]);
        writeText(
            socket,
            replaced === undefined ? text : JSON.stringify({ ...message, result: replaced.result }),
        );
    });
    upstream.addEventListener("close", () => socket.end());
    socket.on("error", () => undefined);
    socket.on("close", () => {
        state.sockets.delete(socket);
        state.upstreams.delete(upstream);
        upstream.close();
    });
    socket.on("data", (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        for (let frame = firstFrame(received); frame !== null; frame = firstFrame(received)) {
            received = received.subarray(frame.byteLength);
            if (frame.opcode === TEXT_FRAME) {
                onCommand(frame.payload.toString());
            } else if (frame.opcode === CLOSE_FRAME) {
                socket.end(frameOf(CLOSE_FRAME, Buffer.alloc(0)));
            }
        }
    });
}

function onUpgrade(
    state: RelayState,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
): void {
    if (state.browserUrl === null) {
        socket.destroy();
        return;
    }
    const upstream = new WebSocket(state.browserUrl);
    state.sockets.add(socket);
    state.upstreams.add(upstream);
    socket.pause();
    upstream.addEventListener("error", () => socket.destroy());
    upstream.addEventListener(
        "open",
        () => {
            socket.write(
                "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    `Sec-WebSocket-Accept: ${acceptKeyFor(request)}\r\n\r\n`,
            );
            relayConnection(state, socket, upstream);
            socket.unshift(head);
            socket.resume();
        },
        { once: true },
    );
}

export async function startCdpRelay(): Promise<CdpRelay> {
    const state: RelayState = {
        browserUrl: null,
        tampering: null,
        commands: [],
        timesTampered: 0,
        lastSessionId: null,
        pausedUrls: new Map(),
        sockets: new Set(),
        upstreams: new Set(),
    };
    const server = createServer();
    server.on("upgrade", (request, socket, head) => {
        onUpgrade(state, request, socket, head);
    });
    await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
    });
    const address: AddressInfo | string | null = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("the relay has no port");
    }

    return {
        url: `ws://127.0.0.1:${address.port}/`,
        forwardTo(url) {
            state.browserUrl = url;
        },
        tamperWith(wanted) {
            state.tampering = wanted;
            state.commands = [];
            state.timesTampered = 0;
        },
        commands: () => [...state.commands],
        timesTampered: () => state.timesTampered,
        sendEvent(method, parameters) {
            const message = { method, params: parameters, sessionId: state.lastSessionId };
            for (const socket of state.sockets) {
                writeText(socket, JSON.stringify(message));
            }
        },
        async close() {
            for (const upstream of state.upstreams) {
                upstream.close();
            }
            for (const socket of state.sockets) {
                socket.destroy();
            }
            await new Promise<void>((resolve) => {
                server.close(() => {
                    resolve();
                });
            });
        },
    };
}
