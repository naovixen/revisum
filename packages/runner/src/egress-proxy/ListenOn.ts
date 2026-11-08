import type { Server } from "node:net";

// Resolves once `server` is listening, and rejects if it can't.
export function listenOn(server: Server, port: number, host: string): Promise<void> {
    return new Promise<void>((resolveListening, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolveListening();
        });
    });
}
