import type { Socket } from "node:net";
import type { AddressConnector } from "./AddressResolver.ts";
import type { OpenSockets } from "./OpenSockets.ts";

// How long one address may take to accept a connection, for every client.
const CONNECT_LIMIT_MILLISECONDS = 30_000;
const NO_TIMEOUT = 0;

// A connection to the first of the addresses to accept, or why none did. Nothing has been sent by
// then, so moving on to the next address can't repeat a request.
export type ConnectInTurn = (
    addresses: readonly string[],
    port: number,
    abandoned: AbortSignal,
) => Promise<Socket | Error>;

type Dialler = {
    readonly connect: AddressConnector;
    readonly sockets: Pick<OpenSockets, "track">;
};

function attemptConnection(
    dialler: Dialler,
    address: string,
    port: number,
    abandoned: AbortSignal,
): Promise<Socket | Error> {
    if (abandoned.aborted) {
        return Promise.resolve(new Error("the client left before a connection opened"));
    }
    return new Promise((settleAttempt) => {
        const socket = dialler.connect(address, port);
        dialler.sockets.track(socket);
        const onAbandoned = (): void => {
            socket.destroy();
        };
        const onLimitReached = (): void => {
            socket.destroy(new Error(`${address} did not accept a connection in time`));
        };
        const onClosedEarly = (): void => {
            settle(new Error(`the connection to ${address} closed before it opened`));
        };
        const settle = (outcome: Socket | Error): void => {
            abandoned.removeEventListener("abort", onAbandoned);
            socket.setTimeout(NO_TIMEOUT, onLimitReached);
            socket.off("error", settle);
            socket.off("close", onClosedEarly);
            settleAttempt(outcome);
        };
        abandoned.addEventListener("abort", onAbandoned, { once: true });
        socket.setTimeout(CONNECT_LIMIT_MILLISECONDS, onLimitReached);
        socket.once("error", settle);
        socket.once("close", onClosedEarly);
        socket.once("connect", () => {
            settle(socket);
        });
    });
}

export function connectingInTurn(
    connect: AddressConnector,
    sockets: Pick<OpenSockets, "track">,
): ConnectInTurn {
    return async (addresses, port, abandoned) => {
        let outcome: Socket | Error = new Error("there was no address to connect to");
        for (const address of addresses) {
            outcome = await attemptConnection({ connect, sockets }, address, port, abandoned);
            if (!(outcome instanceof Error)) {
                return outcome;
            }
        }
        return outcome;
    };
}
