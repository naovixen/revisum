// What happens to the popups, second pages and downloads a page starts. A popup or second page is
// held back from loading anything and closed, and a download is refused by the browser, so nothing
// of either is kept and no request of a popup escapes the session's allow-list; the session layer
// fails the step that started one with unsupported-step. Two openings are not counted: the
// download a download step claimed, and the tab a newTab step asked for, which is handed over
// still paused, before it loads anything.
// The browser says a download has begun only once its server answers, which may be after the run has
// ended. A link with the download attribute says so sooner: the browser asks for its file as it asks
// for a document, with no frame's navigation behind the request, so the Network domain has no id for
// it. Every frame's navigation has one, whoever started it.
import {
    ATTACHED_TO_TARGET,
    DOWNLOAD_WILL_BEGIN,
    type DownloadBegun,
    type RequestPaused,
} from "../connection/BrowserEvent.ts";
import {
    CLOSE_TARGET,
    SET_AUTO_ATTACH,
    SET_DOWNLOAD_BEHAVIOUR,
} from "../connection/BrowserCommand.ts";
import { ENABLE_REQUEST_HOLDING } from "../connection/domains/FetchDomain.ts";
import { RUN_IF_WAITING_FOR_DEBUGGER } from "../connection/domains/RuntimeDomain.ts";
import type { CdpConnection } from "../connection/CdpConnection.ts";

const DOCUMENT_REQUEST = "Document";
const PAGE_TARGET = "page";
const REQUEST_STAGE = "request";

// How long a popup is given to ask for its first page, so that request can be recorded before the
// popup is closed. A popup opened with no address asks for nothing and is closed after this wait.
const POPUP_REQUEST_WAIT_MILLISECONDS = 1_000;

// A link's file, as the top of this file explains: a document asked for with no navigation behind it.
const isRequestForAFile = (paused: RequestPaused): boolean =>
    paused.stage === REQUEST_STAGE &&
    paused.resourceType === DOCUMENT_REQUEST &&
    paused.networkId === undefined;

export type WatchedPage = {
    readonly browserContextId: string;
    readonly targetId: string;
    readonly sessionId: string;
};

// A page the browser attached, still paused before it loads anything.
export type AttachedPage = { readonly targetId: string; readonly sessionId: string };

export type PageOpeningsOptions = {
    // Told the address each held-back popup asked for.
    readonly onPopupRequest?: (url: string) => void;
    // True for the session's first page, which sets up what the whole browser context shares:
    // attaching every new page paused, and refusing downloads. A second tab's watch leaves it be.
    readonly ownsBrowserContext: boolean;
    // Asked about every download the browser starts: true when a download step claimed it, so it
    // is not an unrequested opening.
    readonly claimsDownload?: (begun: DownloadBegun) => boolean;
    // True while a download step is waiting for its file, which then decides what each one is.
    readonly isDownloadStepUnderWay?: () => boolean;
};

// What the openings of a page ask of the watch that owns that page's failures and held requests.
export type OpeningsHost = {
    onRequestPaused(pausedSessionId: string, handler: (paused: RequestPaused) => void): () => void;
    noteTargetFailure(doing: string, error: unknown): void;
    noteUnreadableEvent(detail: string): void;
};

export class PageOpenings {
    readonly #connection: CdpConnection;
    readonly #page: WatchedPage;
    readonly #host: OpeningsHost;
    readonly #onPopupRequest: (url: string) => void;
    readonly #ownsBrowserContext: boolean;
    readonly #claimsDownload: (begun: DownloadBegun) => boolean;
    readonly #isDownloadStepUnderWay: () => boolean;
    #openingCount = 0;
    // A promise per popup still being held back and closed, each with what went wrong noted by its end.
    readonly #popupsClosing = new Set<Promise<void>>();
    // Hands the next page opened without an opener to the newTab step waiting for it.
    #tabClaim: ((page: AttachedPage) => void) | null = null;
    readonly #stopListening: (() => void)[] = [];

    constructor(
        connection: CdpConnection,
        page: WatchedPage,
        options: PageOpeningsOptions,
        host: OpeningsHost,
    ) {
        this.#connection = connection;
        this.#page = page;
        this.#host = host;
        this.#onPopupRequest = options.onPopupRequest ?? (() => undefined);
        this.#ownsBrowserContext = options.ownsBrowserContext;
        this.#claimsDownload = options.claimsDownload ?? (() => false);
        this.#isDownloadStepUnderWay = options.isDownloadStepUnderWay ?? (() => false);
    }

    // Every new page in the browser is attached paused, before it loads anything. One in the
    // session's own browser context is a popup or a second page, and is closed, unless it is the
    // tab a newTab step is waiting for. A page of another context is never let run from here: that
    // would start it before its own session has made it hold back its requests.
    startListening(): void {
        const connection = this.#connection;
        const { browserContextId, targetId } = this.#page;
        this.#stopListening.push(
            connection.listen(
                undefined,
                ATTACHED_TO_TARGET,
                (attached) => {
                    const info = attached.targetInfo;
                    if (
                        info.type === PAGE_TARGET &&
                        info.browserContextId === browserContextId &&
                        info.targetId !== targetId
                    ) {
                        const claim = this.#tabClaim;
                        if (claim !== null && info.openerId === undefined) {
                            this.#tabClaim = null;
                            claim({ targetId: info.targetId, sessionId: attached.sessionId });
                            return;
                        }
                        this.#openingCount += 1;
                        this.#keepClosing(this.#closePopup(attached.sessionId, info.targetId));
                        return;
                    }
                    if (attached.waitingForDebugger && info.browserContextId === browserContextId) {
                        connection
                            .ask(attached.sessionId, RUN_IF_WAITING_FOR_DEBUGGER, {})
                            .catch((error: unknown) => {
                                this.#host.noteTargetFailure(
                                    "a new target could not be let run",
                                    error,
                                );
                            });
                    }
                },
                (detail) => {
                    this.#host.noteUnreadableEvent(detail);
                },
            ),
        );
        // A download the driver cannot read is one nobody claimed.
        this.#stopListening.push(
            connection.listen(
                undefined,
                DOWNLOAD_WILL_BEGIN,
                (begun) => {
                    if (!this.#claimsDownload(begun)) {
                        this.#openingCount += 1;
                    }
                },
                () => {
                    this.#openingCount += 1;
                },
            ),
        );
    }

    // Makes the browser attach every new page paused and refuse every download, when this page is
    // the one that sets up its browser context.
    async holdNewPagesAndRefuseDownloads(): Promise<void> {
        if (!this.#ownsBrowserContext) {
            return;
        }
        await this.#connection.ask(undefined, SET_AUTO_ATTACH, {
            autoAttach: true,
            waitForDebuggerOnStart: true,
            flatten: true,
            filter: [{ type: PAGE_TARGET }],
        });
        // Every download is refused, so no file of one is ever written; the events still say it began.
        // A download step lets the browser save the one download it claims, and refuses again after.
        await this.#connection.ask(undefined, SET_DOWNLOAD_BEHAVIOUR, {
            behavior: "deny",
            browserContextId: this.#page.browserContextId,
            eventsEnabled: true,
        });
    }

    // Stops listening, once the page is closed.
    stop(): void {
        for (const stopListening of this.#stopListening.splice(0)) {
            stopListening();
        }
        this.#tabClaim = null;
    }

    // Counts a file the page's own request asks for, as the top of this file explains.
    noteRequestHeld(pausedSessionId: string, paused: RequestPaused): void {
        if (
            pausedSessionId === this.#page.sessionId &&
            isRequestForAFile(paused) &&
            !this.#isDownloadStepUnderWay()
        ) {
            this.#openingCount += 1;
        }
    }

    unsupportedOpenings(): number {
        return this.#openingCount;
    }

    // Resolves with the next page the browser context opens without an opener, still paused, which
    // the caller then prepares and lets run. It is not counted as an opening and not closed.
    nextTab(timeoutMilliseconds: number): {
        readonly promise: Promise<AttachedPage>;
        cancel(): void;
    } {
        let timer: NodeJS.Timeout | undefined;
        const promise = new Promise<AttachedPage>((resolve, reject) => {
            this.#tabClaim = (page) => {
                clearTimeout(timer);
                resolve(page);
            };
            timer = setTimeout(() => {
                this.#tabClaim = null;
                reject(new Error(`no new tab attached within ${timeoutMilliseconds} ms`));
            }, timeoutMilliseconds);
        });
        return {
            promise,
            cancel: () => {
                clearTimeout(timer);
                this.#tabClaim = null;
            },
        };
    }

    // Resolves when each popup open now has been held back and closed; one opened later is not waited for.
    popupsClosed(): Promise<unknown> {
        return Promise.all(this.#popupsClosing);
    }

    // A popup that can reach its opener shares the opener's renderer process, so while it waits to
    // start, the opener waits too. Its every request is held back first, so it loads nothing; then
    // it is let start, its first request (held back) is recorded, and it is closed.
    async #closePopup(popupSessionId: string, popupTargetId: string): Promise<void> {
        const connection = this.#connection;
        let endWait = (): void => undefined;
        // Its own timer settles it, whatever the commands below do, and the session's close awaits it.
        const firstRequest = new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                endWait();
            }, POPUP_REQUEST_WAIT_MILLISECONDS);
            const stopListening = this.#host.onRequestPaused(popupSessionId, (paused) => {
                this.#onPopupRequest(paused.request.url);
                endWait();
            });
            endWait = () => {
                clearTimeout(timer);
                stopListening();
                resolve();
            };
        });
        try {
            await connection.ask(popupSessionId, ENABLE_REQUEST_HOLDING, {
                patterns: [{ urlPattern: "*", requestStage: "Request" }],
            });
            await connection.ask(popupSessionId, RUN_IF_WAITING_FOR_DEBUGGER, {});
            await firstRequest;
        } catch (error) {
            this.#host.noteTargetFailure("a popup could not be held back", error);
        } finally {
            endWait();
        }
        await connection
            .ask(undefined, CLOSE_TARGET, { targetId: popupTargetId })
            .catch((error: unknown) => {
                this.#host.noteTargetFailure("a popup could not be closed", error);
            });
    }

    #keepClosing(closing: Promise<void>): void {
        this.#popupsClosing.add(closing);
        void closing.finally(() => {
            this.#popupsClosing.delete(closing);
        });
    }
}
