// Records how each request of a session left the browser: an ordinary request of the page, a
// WebSocket, a worker's request, a popup's first load, a redirect or a beacon. The egress proxy
// outside the browser sees only hosts and ports over HTTPS, so these records give its decisions
// their channels. Only network schemes are recorded; data:, blob: and the like never leave, and
// neither does a request a declared stub answered inside the browser, so it is left out.
import type { BrowserChannel, BrowserRequestRecord } from "@revisum/contracts";
import { errorText } from "../connection/ErrorText.ts";
import {
    ATTACHED_TO_TARGET,
    REQUEST_WILL_BE_SENT,
    WEB_SOCKET_CREATED,
} from "../connection/BrowserEvent.ts";
import { ENABLE_NETWORK, SET_AUTO_ATTACH } from "../connection/BrowserCommand.ts";
import { RUN_IF_WAITING_FOR_DEBUGGER } from "../connection/RuntimeDomain.ts";
import type { CdpConnection } from "../connection/CdpConnection.ts";
import { holdUnreadableEvent, type SessionFailures } from "../page/PageWatch.ts";

// How a command to a worker fails when the worker has already ended, or the browser or session has gone.
const WORKER_ALREADY_GONE =
    /Session with given id not found|No target with given id|connection closed/i;

// What sort of request left the browser, as far as the record says: a redirect, a beacon, or what an
// ordinary request of the session is.
function channelOfRequest(
    hasRedirect: boolean,
    type: string | undefined,
    ordinary: BrowserChannel,
): BrowserChannel {
    if (hasRedirect) {
        return "redirect";
    }
    return type === "Ping" ? "beacon" : ordinary;
}

const NETWORK_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);

// The origin of a URL whose scheme reaches the network. A URL that can't be parsed could not have been
// sent anywhere.
function networkOrigin(url: string): string | null {
    const parsed = URL.parse(url);
    return parsed !== null && NETWORK_SCHEMES.has(parsed.protocol) ? parsed.origin : null;
}

export class EgressRecorder {
    readonly #connection: CdpConnection;
    readonly #failures: SessionFailures;
    // Each record with the Network domain's id of its request, when it has one.
    readonly #records: {
        readonly record: BrowserRequestRecord;
        readonly requestId: string | null;
    }[] = [];
    // The ids of the requests a stub answered inside the browser.
    readonly #answeredInBrowser = new Set<string>();

    constructor(connection: CdpConnection, failures: SessionFailures) {
        this.#connection = connection;
        this.#failures = failures;
    }

    records(): readonly BrowserRequestRecord[] {
        return this.#records
            .filter(
                (kept) => kept.requestId === null || !this.#answeredInBrowser.has(kept.requestId),
            )
            .map((kept) => kept.record);
    }

    // Leaves the request out of the records: a stub answered it, so it never left the browser. The
    // stub may answer before or after the request is recorded, so it is left out as records are read.
    answeredInBrowser(requestId: string): void {
        this.#answeredInBrowser.add(requestId);
    }

    // Notes a request by its URL, when its scheme reaches the network.
    record(url: string, channel: BrowserChannel, requestId: string | null = null): void {
        const origin = networkOrigin(url);
        if (origin !== null) {
            this.#records.push({ record: { origin, channel }, requestId });
        }
    }

    // Notes a held-back popup whose origin the run may not reach, so its record says it was refused too.
    recordUndeclaredPopup(url: string): void {
        const origin = networkOrigin(url);
        if (origin !== null) {
            this.#records.push({
                record: { origin, channel: "popup", undeclared: true },
                requestId: null,
            });
        }
    }

    // Watches one session's requests; `channel` is what an ordinary request of that session is.
    #watch(sessionId: string, channel: BrowserChannel): void {
        const onMalformed = holdUnreadableEvent(this.#failures);
        this.#connection.listen(
            sessionId,
            REQUEST_WILL_BE_SENT,
            (sent) => {
                this.record(
                    sent.request.url,
                    channelOfRequest(sent.redirectResponse !== undefined, sent.type, channel),
                    sent.requestId,
                );
            },
            onMalformed,
        );
        this.#connection.listen(
            sessionId,
            WEB_SOCKET_CREATED,
            (created) => {
                this.record(created.url, "websocket");
            },
            onMalformed,
        );
    }

    // Starts recording the page's requests and its dedicated workers'. A worker is attached paused,
    // so its first request is not missed, and let run once its requests are watched.
    async start(pageSessionId: string): Promise<void> {
        const connection = this.#connection;
        this.#watch(pageSessionId, "page");
        connection.listen(
            pageSessionId,
            ATTACHED_TO_TARGET,
            (attached) => {
                const isWorker = attached.targetInfo.type === "worker";
                if (isWorker) {
                    this.#watch(attached.sessionId, "worker");
                }
                void this.#letRun(attached.sessionId, isWorker, attached.waitingForDebugger);
            },
            holdUnreadableEvent(this.#failures),
        );
        await connection.ask(pageSessionId, ENABLE_NETWORK, {});
        await connection.ask(pageSessionId, SET_AUTO_ATTACH, {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
            filter: [{ type: "worker" }],
        });
    }

    // Each step is tried whatever the other did: a worker left paused does nothing at all. Never rejects,
    // since it runs as an event arrives: a failure is for the session's close to report.
    async #letRun(sessionId: string, isWorker: boolean, isWaiting: boolean): Promise<void> {
        if (isWorker) {
            await this.#connection.ask(sessionId, ENABLE_NETWORK, {}).catch((error: unknown) => {
                this.#noteWorkerFailure(error);
            });
        }
        if (isWaiting) {
            await this.#connection
                .ask(sessionId, RUN_IF_WAITING_FOR_DEBUGGER, {})
                .catch((error: unknown) => {
                    this.#noteWorkerFailure(error);
                });
        }
    }

    #noteWorkerFailure(error: unknown): void {
        const text = errorText(error);
        if (!WORKER_ALREADY_GONE.test(text)) {
            this.#failures.cleanUp.push(`a worker could not be watched: ${text}`);
        }
    }
}
