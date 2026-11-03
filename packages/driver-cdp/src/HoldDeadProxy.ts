import { createServer } from "node:net";

const LOOPBACK_ADDRESS = "127.0.0.1";

export type DeadProxy = {
    readonly server: string;
    // Safe to call more than once.
    close(): Promise<void>;
};

// A browser-wide proxy that leads nowhere, for Chrome's own traffic. A port that is merely closed could
// be bound by another program on the machine, which would then receive that traffic, so this holds
// the port and closes every connection it gets.
export async function holdDeadProxy(): Promise<DeadProxy> {
    const listener = createServer((connection) => {
        connection.destroy();
    });
    await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(0, LOOPBACK_ADDRESS, () => {
            listener.off("error", reject);
            resolve();
        });
    });
    const address = listener.address();
    if (address === null || typeof address === "string") {
        throw new Error("the dead proxy's listener has no port");
    }
    let closing: Promise<void> | undefined;
    return {
        server: `http://${LOOPBACK_ADDRESS}:${address.port}`,
        close: () => {
            closing ??= new Promise((resolve) => {
                listener.close(() => {
                    resolve();
                });
            });
            return closing;
        },
    };
}
