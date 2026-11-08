import { failure, success, type Result } from "@revisum/contracts";
import type { Server } from "node:net";
import { listenOn } from "./ListenOn.ts";
import type { OpenSockets } from "./OpenSockets.ts";
import { ProxyStartFailureCode, type ProxyStartFailure } from "./ProxyStartFailure.ts";

export type PlannedListener = { readonly server: Server; readonly port: number };

export type ProxyCloseFailure = { readonly message: string };

export type ProxyListeners = {
    // Opens each listener in turn and gives the port of the last. When one can't listen, every one
    // opened is closed before the failure is given.
    readonly openInOrder: (
        planned: readonly PlannedListener[],
    ) => Promise<Result<number, ProxyStartFailure>>;
    // Ends every open socket and closes every listener, and waits for them. Asked again, it gives the
    // same outcome, so a second close is harmless.
    readonly close: () => Promise<Result<void, ProxyCloseFailure>>;
};

type ProxyListenersPorts = {
    readonly listenHost: string;
    readonly sockets: Pick<OpenSockets, "track" | "destroyAll">;
    readonly noteFailure: (message: string) => void;
};

const closedListener = (server: Server): Promise<string | null> =>
    new Promise((settle) => {
        server.close((error) => {
            settle(error?.message ?? null);
        });
    });

export function createProxyListeners(ports: ProxyListenersPorts): ProxyListeners {
    const { listenHost, sockets, noteFailure } = ports;
    const opened: Server[] = [];

    const closeEveryListener = async (): Promise<Result<void, ProxyCloseFailure>> => {
        sockets.destroyAll();
        const failures = (await Promise.all(opened.map(closedListener))).filter(
            (message) => message !== null,
        );
        return failures.length === 0
            ? success(undefined)
            : failure({ message: failures.join("; ") });
    };

    let closing: Promise<Result<void, ProxyCloseFailure>> | undefined;
    const close = (): Promise<Result<void, ProxyCloseFailure>> => {
        closing ??= closeEveryListener();
        return closing;
    };

    const openOne = async (planned: PlannedListener): Promise<Result<number, string>> => {
        planned.server.on("connection", sockets.track);
        const listening = await listenOn(planned.server, planned.port, listenHost, (error) => {
            noteFailure(error.message);
        });
        if (listening.ok) {
            opened.push(planned.server);
        }
        return listening;
    };

    return {
        close,
        openInOrder: async (planned) => {
            let lastPort = 0;
            for (const listener of planned) {
                const listening = await openOne(listener);
                if (!listening.ok) {
                    const closed = await close();
                    return failure({
                        code: ProxyStartFailureCode.ListenFailed,
                        port: listener.port,
                        message: closed.ok
                            ? listening.error
                            : `${listening.error}; and a listener would not close: ${closed.error.message}`,
                    });
                }
                lastPort = listening.value;
            }
            return success(lastPort);
        },
    };
}
