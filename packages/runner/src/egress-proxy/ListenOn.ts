import { failure, success, type Result } from "@revisum/contracts";
import type { Server } from "node:net";
import { asError } from "./AsError.ts";

// Listens, and gives the port listened on, or why it couldn't. A listener's later error, such as a
// failed accept, goes to `onLaterFailure`: left unheard, it would end the process.
export function listenOn(
    server: Server,
    port: number,
    host: string,
    onLaterFailure: (error: Error) => void,
): Promise<Result<number, string>> {
    return new Promise((settle) => {
        const onListenFailed = (error: Error): void => {
            settle(failure(error.message));
        };
        server.once("error", onListenFailed);
        try {
            server.listen(port, host, () => {
                server.off("error", onListenFailed);
                server.on("error", onLaterFailure);
                const address = server.address();
                settle(
                    address === null || typeof address === "string"
                        ? failure("the listener has no port")
                        : success(address.port),
                );
            });
        } catch (error) {
            server.off("error", onListenFailed);
            settle(failure(asError(error, "listening failed").message));
        }
    });
}
