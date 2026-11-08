import type { Socket } from "node:net";
import type { AddressConnector } from "./AddressConnector.ts";
import type { CheckedAddresses } from "./AddressVetter.ts";
import { asError } from "./AsError.ts";
import type { ConnectDeadline } from "./ConnectDeadline.ts";
import type { OpenSockets } from "./OpenSockets.ts";

export const ConnectOutcomeKind = { Connected: "connected", Failed: "failed" } as const;

export type ConnectOutcome =
    | { readonly kind: typeof ConnectOutcomeKind.Connected; readonly socket: Socket }
    | { readonly kind: typeof ConnectOutcomeKind.Failed; readonly failure: Error };

const failed = (failure: Error): ConnectOutcome => ({
    kind: ConnectOutcomeKind.Failed,
    failure,
});

// A connection to the first of the addresses to accept, or why none did. Nothing has been sent by
// then, so moving on to the next address can't repeat a request. Every attempt shares the deadline,
// each getting the time left divided by the addresses left, so a silent address can't starve the rest.
export type ConnectInTurn = (
    addresses: CheckedAddresses,
    port: number,
    deadline: ConnectDeadline,
) => Promise<ConnectOutcome>;

type Dialler = {
    readonly connect: AddressConnector;
    readonly sockets: Pick<OpenSockets, "track">;
};

function outcomeOfSocket(
    socket: Socket,
    address: string,
    deadline: ConnectDeadline,
    shareMilliseconds: number,
): Promise<ConnectOutcome> {
    return new Promise((settleAttempt) => {
        // Settled here rather than by the socket's own events, since a socket that is already dead
        // emits none. Destroyed with no error, as nothing listens for one once this has settled.
        const abandon = (reason: Error): void => {
            socket.destroy();
            settle(failed(reason));
        };
        const onDeadline = (): void => {
            abandon(deadline.failure());
        };
        const shareTimer = setTimeout(() => {
            abandon(new Error(`${address} opened no connection within its share of the limit`));
        }, shareMilliseconds);
        const settle = (outcome: ConnectOutcome): void => {
            clearTimeout(shareTimer);
            deadline.ended.removeEventListener("abort", onDeadline);
            socket.off("error", onError);
            socket.off("close", onClosedEarly);
            socket.off("connect", onConnected);
            settleAttempt(outcome);
        };
        const onError = (error: Error): void => {
            settle(failed(error));
        };
        const onClosedEarly = (): void => {
            settle(failed(new Error(`the connection to ${address} closed before it opened`)));
        };
        const onConnected = (): void => {
            settle({ kind: ConnectOutcomeKind.Connected, socket });
        };
        deadline.ended.addEventListener("abort", onDeadline, { once: true });
        socket.once("error", onError);
        socket.once("close", onClosedEarly);
        socket.once("connect", onConnected);
    });
}

function attemptConnection(
    dialler: Dialler,
    address: string,
    port: number,
    deadline: ConnectDeadline,
    addressesLeft: number,
): Promise<ConnectOutcome> {
    if (deadline.ended.aborted) {
        return Promise.resolve(failed(deadline.failure()));
    }
    try {
        const socket = dialler.connect(address, port);
        dialler.sockets.track(socket);
        return outcomeOfSocket(
            socket,
            address,
            deadline,
            deadline.millisecondsLeft() / addressesLeft,
        );
    } catch (error) {
        return Promise.resolve(failed(asError(error, `connecting to ${address} failed`)));
    }
}

export function connectingInTurn(
    connect: AddressConnector,
    sockets: Pick<OpenSockets, "track">,
): ConnectInTurn {
    const dialler: Dialler = { connect, sockets };
    return async (addresses, port, deadline) => {
        const [first, ...others] = addresses;
        let outcome = await attemptConnection(dialler, first, port, deadline, addresses.length);
        for (const [index, address] of others.entries()) {
            if (outcome.kind === ConnectOutcomeKind.Connected) {
                break;
            }
            const addressesLeft = others.length - index;
            outcome = await attemptConnection(dialler, address, port, deadline, addressesLeft);
        }
        return outcome;
    };
}
