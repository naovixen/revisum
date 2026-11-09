// How a run container learns what its proxy, in another container, refused its browser. A run's result
// holds those refusals and is hashed inside the run container, so the host reading them afterwards would
// be too late. The list has a port of its own on the proxy container, which answers every request with
// it and takes nothing in. A page can't reach it: the browser sends everything but its own loopback
// through the proxy, which refuses this undeclared address, and the run's network has no other way
// there. Nor can a page forge an entry, since only the proxy's own decisions go on the list.
import { failure, success, type Result } from "@revisum/contracts";
import { createServer, get } from "node:http";

const REFUSALS_PORT = 3130;
const LISTEN_ON_EVERY_INTERFACE = "0.0.0.0";
const READ_LIMIT_MILLISECONDS = 10_000;
const JSON_MEDIA_TYPE = "application/json";

// Serves the list as it stands at each request. It grows in place, as the proxy refuses.
export function startRefusalsServer(browserRefusals: readonly string[]): Promise<void> {
    const server = createServer((incoming, response) => {
        response
            .writeHead(200, { "content-type": JSON_MEDIA_TYPE })
            .end(JSON.stringify(browserRefusals));
    });
    return new Promise((resolveListening, reject) => {
        server.once("error", reject);
        server.listen(REFUSALS_PORT, LISTEN_ON_EVERY_INTERFACE, () => {
            server.off("error", reject);
            resolveListening();
        });
    });
}

const isTextList = (value: unknown): value is readonly string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");

function decodeRefusals(text: string): Result<readonly string[], string> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch (error) {
        return failure(`the proxy's refusals are not JSON: ${String(error)}`);
    }
    return isTextList(parsed) ? success(parsed) : failure("the proxy's refusals are not a list");
}

// Everything the proxy behind this address has refused a browser so far, oldest first, or why that
// can't be read.
export function readBrowserRefusals(
    proxyServer: string,
): Promise<Result<readonly string[], string>> {
    const proxy = URL.parse(proxyServer);
    if (proxy === null) {
        return Promise.resolve(failure("the proxy's address is not a URL"));
    }
    return new Promise((settle) => {
        const unread = (why: string): void => {
            settle(failure(`the proxy's refusals could not be read: ${why}`));
        };
        get(
            {
                host: proxy.hostname.replace(/^\[(.*)\]$/, "$1"),
                port: REFUSALS_PORT,
                agent: false,
                signal: AbortSignal.timeout(READ_LIMIT_MILLISECONDS),
            },
            (answer) => {
                let text = "";
                answer.setEncoding("utf8");
                answer.on("data", (chunk: string) => {
                    text += chunk;
                });
                answer.on("end", () => {
                    settle(decodeRefusals(text));
                });
                answer.on("error", (error) => {
                    unread(error.message);
                });
            },
        ).on("error", (error) => {
            unread(error.message);
        });
    });
}
