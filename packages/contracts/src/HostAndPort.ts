import type { SeenOrigin } from "./isolated-runner.ts";

const DEFAULT_PORTS: Readonly<Record<string, string>> = {
    "http:": "80",
    "ws:": "80",
    "https:": "443",
    "wss:": "443",
};
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

// The host and port an origin reaches, so "ws://socket.test" (as the browser reports a WebSocket)
// meets "socket.test:80" (the tunnel the proxy was asked for).
export function hostAndPort(origin: SeenOrigin): string {
    const url = HAS_SCHEME.test(origin) ? URL.parse(origin) : null;
    if (url === null) {
        return origin.toLowerCase();
    }
    return `${url.hostname}:${url.port === "" ? (DEFAULT_PORTS[url.protocol] ?? "") : url.port}`;
}
