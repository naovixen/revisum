import type { Duplex } from "node:stream";
import { abortedOnClose } from "./AbortedOnClose.ts";

// Every open socket of one proxy, so that closing the proxy can end them.
export type OpenSockets = {
    readonly track: (socket: Duplex) => void;
    // Tracks a client's connection, ends it when it fails, and gives a signal that aborts once it has
    // closed.
    readonly adoptClient: (client: Duplex) => AbortSignal;
    readonly destroyAll: () => void;
};

export function createOpenSockets(): OpenSockets {
    const open = new Set<Duplex>();
    const track = (socket: Duplex): void => {
        open.add(socket);
        socket.once("close", () => {
            open.delete(socket);
        });
    };
    return {
        track,
        adoptClient: (client) => {
            track(client);
            client.on("error", () => {
                client.destroy();
            });
            return abortedOnClose(client);
        },
        destroyAll: () => {
            for (const socket of open) {
                socket.destroy();
            }
        },
    };
}
