// Watches one driver page from outside any command: whether its renderer has died, the dialog it
// has open, and whether its top document is on its way to another. What the page opens is PageOpenings'.
// Once the page has crashed, every command to it fails at once: the browser never answers a
// command sent to a dead renderer, so waiting would only run into each command's timeout. A browser
// that dies or a connection that closes takes the page with it, so both count as a crash.
// Once a dialog is open, every command that needs the page fails at once in the same way, and one
// under way fails as the dialog opens, so this is the one place that dialog state is read for them.
// A request stays held until the browser takes the driver's decision on it, so a decision it refuses
// is held here too, whenever its answer comes, for whatever reports next.
import { errorText } from "../connection/ErrorText.ts";
import {
    DETACHED_FROM_TARGET,
    DIALOG_CLOSED,
    DIALOG_OPENING,
    INSPECTOR_TARGET_CRASHED,
    FRAME_NAVIGATED,
    FRAME_REQUESTED_NAVIGATION,
    FRAME_STOPPED_LOADING,
    NAVIGATED_WITHIN_DOCUMENT,
    REQUEST_PAUSED,
    TARGET_CRASHED,
    type BrowserEvent,
    type RequestPaused,
} from "../connection/BrowserEvent.ts";
import {
    ENABLE_INSPECTOR,
    HANDLE_DIALOG,
    type BrowserCommand,
} from "../connection/BrowserCommand.ts";
import type { CdpConnection } from "../connection/CdpConnection.ts";
import { CdpError } from "../connection/CdpError.ts";
import type { PageEvents } from "./PageEvents.ts";
import {
    PageOpenings,
    type AttachedPage,
    type OpeningsHost,
    type PageOpeningsOptions,
    type WatchedPage,
} from "./PageOpenings.ts";
import { PageHeldByDialog } from "./failures/PageHeldByDialog.ts";

// How a command fails when a target closed itself first, or the browser or the session has gone.
// Nothing is left to act on then, so there is nothing to report.
const TARGET_ALREADY_GONE =
    /Session with given id not found|No target with given id|connection closed/i;
// What the browser answers about a tab that has gone, so a tab the driver closed reads as one.
const SESSION_GONE = "Session with given id not found.";
// How a decision on a request fails when nothing is held any more: the page gave up on the request or
// died, its tab or browser context has gone, or the session has closed. Each is the browser's exact
// answer, so no other refusal can pass for one.
const REQUEST_NO_LONGER_HELD =
    /^Fetch\.\w+: (?:Invalid InterceptionId\.|Session with given id not found\.|connection closed)$/;
// A navigation that stays in this page's tab, as the browser says of one it was asked for.
const THIS_TAB = "currentTab";

// What every page of one session holds together, so a tab that closes takes none of it with it.
export type SessionFailures = {
    readonly refusedDecisions: string[];
    readonly cleanUp: string[];
};

// What a held request's decision depends on may be in an event the driver cannot read, and what comes
// after it says no more than after a refused decision, so it is kept with those.
export const holdUnreadableEvent =
    (failures: SessionFailures) =>
    (detail: string): void => {
        failures.refusedDecisions.push(
            `the driver could not read what the browser said, so it decided nothing on it: ${detail}`,
        );
    };

type PageWatchOptions = PageOpeningsOptions & { readonly failures: SessionFailures };

export class PageWatch implements PageEvents, OpeningsHost {
    readonly #connection: CdpConnection;
    readonly #page: WatchedPage;
    #crashed = false;
    #isClosedByDriver = false;
    #dialog: string | null = null;
    #isNavigationUnderWay = false;
    readonly #onCrash = new Set<() => void>();
    readonly #onDialog = new Set<() => void>();
    readonly #onNavigationEnded = new Set<() => void>();
    readonly #onDecisionRefused = new Set<(refusal: string) => void>();
    readonly #failures: SessionFailures;
    readonly #openings: PageOpenings;
    #pressCount = 0;
    readonly #stopListening: (() => void)[] = [];

    constructor(connection: CdpConnection, page: WatchedPage, options: PageWatchOptions) {
        this.#connection = connection;
        this.#page = page;
        this.#failures = options.failures;
        this.#openings = new PageOpenings(connection, page, options, this);
    }

    // Starts listening. Called once, before the page loads anything.
    async start(): Promise<void> {
        const { targetId, sessionId } = this.#page;
        const connection = this.#connection;
        this.#stopListening.push(
            connection.onLost(() => {
                this.#crash();
            }),
        );
        this.#listen(sessionId, INSPECTOR_TARGET_CRASHED, () => {
            this.#crash();
        });
        this.#listen(undefined, TARGET_CRASHED, (crashed) => {
            if (crashed.targetId === targetId) {
                this.#crash();
            }
        });
        this.#listen(undefined, DETACHED_FROM_TARGET, (detached) => {
            if (detached.sessionId === sessionId) {
                this.#crash();
            }
        });
        this.#listen(sessionId, DIALOG_OPENING, (opening) => {
            this.#dialog = opening.message;
            for (const notify of [...this.#onDialog]) {
                notify();
            }
            this.#notifyNavigationWaiters();
        });
        this.#listen(sessionId, DIALOG_CLOSED, (closed) => {
            this.#dialog = null;
            // Dismissing what a page asks before it unloads cancels the navigation, and nothing else says so.
            if (!closed.result) {
                this.#endNavigation();
            }
        });
        this.#watchNavigations();
        this.#openings.startListening();
        await connection.ask(sessionId, ENABLE_INSPECTOR, {});
        await this.#openings.holdNewPagesAndRefuseDownloads();
    }

    #listen<Payload>(
        listenedSession: string | undefined,
        event: BrowserEvent<Payload>,
        handler: (payload: Payload) => void,
    ): void {
        this.#stopListening.push(
            this.#connection.listen(listenedSession, event, handler, (detail) => {
                this.noteUnreadableEvent(detail);
            }),
        );
    }

    // The id of the next press in this page, so what its check reports is told from any other's.
    nextPressId(): string {
        this.#pressCount += 1;
        return `press-${this.#pressCount}`;
    }

    // Stops listening, once the page is closed.
    stop(): void {
        for (const stopListening of this.#stopListening.splice(0)) {
            stopListening();
        }
        this.#openings.stop();
        this.#notifyNavigationWaiters();
    }

    // From now on nothing more is sent to this page. Called before the close is sent: the browser answers
    // a close before the tab detaches, and may never answer a command sent in between. A closed tab has
    // not crashed, so crashed() stays false.
    markClosedByDriver(): void {
        this.#isClosedByDriver = true;
    }

    // Counts the page as gone once its session has closed, so every later call says so as a crash does.
    // Nothing from the browser can be relied on to say it: a browser whose process tree was ended sends
    // no detach first, and a connection closed on purpose tells no listener.
    endWithSession(): void {
        this.stop();
        this.#crash();
    }

    nextTab(timeoutMilliseconds: number): {
        readonly promise: Promise<AttachedPage>;
        cancel(): void;
    } {
        return this.#openings.nextTab(timeoutMilliseconds);
    }

    crashed(): boolean {
        return this.#crashed;
    }

    openDialog(): string | null {
        return this.#dialog;
    }

    async answerDialog(shouldAccept: boolean): Promise<void> {
        await this.ask(HANDLE_DIALOG, { accept: shouldAccept });
    }

    unsupportedOpenings(): number {
        return this.#openings.unsupportedOpenings();
    }

    refusedRequestDecisions(): readonly string[] {
        return [...this.#failures.refusedDecisions];
    }

    // Waits until each popup open now has been held back, has asked for its first page or used up its
    // wait, and been closed, so the session's record of them is complete and one that would not close is
    // reported, and rejects with every clean-up that failed, in any tab. Popups opened during the wait are
    // not waited for, so a page that keeps opening them cannot hold the session's close.
    async settleHeldPopupsAndReportCleanUp(): Promise<void> {
        await this.#openings.popupsClosed();
        if (this.#failures.cleanUp.length > 0) {
            throw new Error(this.#failures.cleanUp.join("; "));
        }
    }

    // A clean-up that failed can't change what a step found, so it waits for the session's close to say.
    noteCleanUpFailure(failure: string): void {
        this.#failures.cleanUp.push(failure);
    }

    // Told how something done to a page, a popup or a tab failed. One that has already gone, or a browser
    // or a session that has, leaves nothing to report.
    noteTargetFailure(doing: string, error: unknown): void {
        const text = errorText(error);
        if (!TARGET_ALREADY_GONE.test(text)) {
            this.noteCleanUpFailure(`${doing}: ${text}`);
        }
    }

    // An event of another shape says nothing the driver can act on, so it counts as a refused decision.
    noteUnreadableEvent(detail: string): void {
        this.#holdRefusal(
            `the driver could not read what the browser said, so it decided nothing on it: ${detail}`,
        );
    }

    // Told how a decision on a request failed. Runs as the browser's answer arrives, with no step to
    // hand it to, so it only keeps what the next outcome must report.
    noteDecisionFailure(error: unknown): void {
        const answer = errorText(error);
        if (REQUEST_NO_LONGER_HELD.test(answer)) {
            return;
        }
        this.#holdRefusal(`the browser refused the driver's decision on a request: ${answer}`);
    }

    #holdRefusal(refusal: string): void {
        this.#failures.refusedDecisions.push(refusal);
        for (const notify of [...this.#onDecisionRefused]) {
            notify(refusal);
        }
    }

    // Calls handler for each request a session's page holds. Runs as the event arrives, with no step to
    // hand a failure to. A request the driver cannot read stays held with no decision on it, so what
    // comes after it says no more than after a refused decision, and it is kept with those.
    onRequestPaused(pausedSessionId: string, handler: (paused: RequestPaused) => void): () => void {
        return this.#connection.listen(
            pausedSessionId,
            REQUEST_PAUSED,
            (paused) => {
                this.#openings.noteRequestHeld(pausedSessionId, paused);
                handler(paused);
            },
            (detail) => {
                this.#holdRefusal(
                    `the driver could not read a request the browser holds, so it decided nothing on it: ${detail}`,
                );
            },
        );
    }

    // Waits for what cannot end while this page's requests stay held, such as its load, for at most
    // until the browser refuses a decision on one of them.
    failingOnRefusedDecision<Value>(waited: Promise<Value>): Promise<Value> {
        const refused = Promise.withResolvers<never>();
        const fail = (refusal: string): void => {
            refused.reject(new Error(refusal));
        };
        this.#onDecisionRefused.add(fail);
        return Promise.race([waited, refused.promise]).finally(() => {
            this.#onDecisionRefused.delete(fail);
        });
    }

    // Resolves as soon as a dialog is open, at once when one already is.
    dialogOpened(): { readonly promise: Promise<void>; cancel(): void } {
        let notify = (): void => undefined;
        const promise = new Promise<void>((resolve) => {
            if (this.#dialog !== null) {
                resolve();
                return;
            }
            notify = () => {
                this.#onDialog.delete(notify);
                resolve();
            };
            this.#onDialog.add(notify);
        });
        return {
            promise,
            cancel: () => {
                this.#onDialog.delete(notify);
            },
        };
    }

    // Resolves when a dialog opens from now on, whatever is open already: the wait of a navigation, which
    // ends the page's old dialog and answers for the new document's.
    nextDialogOpened(): { readonly promise: Promise<void>; cancel(): void } {
        let notify = (): void => undefined;
        const promise = new Promise<void>((resolve) => {
            notify = () => {
                this.#onDialog.delete(notify);
                resolve();
            };
            this.#onDialog.add(notify);
        });
        return {
            promise,
            cancel: () => {
                this.#onDialog.delete(notify);
            },
        };
    }

    // Resolves once the top document is not on its way to another, or a dialog or a crash has stopped
    // it from getting there: at once when it is not. A press sends its navigation before the browser
    // has anything to show for it, and the old page goes on answering meanwhile.
    navigationEnded(): Promise<void> {
        if (!this.#isNavigationUnderWay || this.#dialog !== null || this.#crashed) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.#onNavigationEnded.add(resolve);
        });
    }

    // Sends a command to the page, with its reply parsed before anyone sees it. It fails at once on a
    // crashed page or one the driver has closed, and as soon as the page crashes while it waits.
    ask<CommandParameters, Reply>(
        command: BrowserCommand<CommandParameters, Reply>,
        parameters: NoInfer<CommandParameters>,
    ): Promise<Reply> {
        if (this.#crashed) {
            return Promise.reject(new CdpError(command.method, "the page's renderer died"));
        }
        if (this.#isClosedByDriver) {
            return Promise.reject(new CdpError(command.method, SESSION_GONE));
        }
        return this.failingOnCrash(
            command.method,
            this.#connection.ask(this.#page.sessionId, command, parameters),
        );
    }

    // Sends a decision on, or a question about, a request the page holds. A crash does not fail it as it
    // does ask: only the browser's own answer says whether the request is still held, and a decision that
    // failed any other way counts as refused.
    askAboutHeldRequest<CommandParameters, Reply>(
        command: BrowserCommand<CommandParameters, Reply>,
        parameters: NoInfer<CommandParameters>,
    ): Promise<Reply> {
        if (this.#isClosedByDriver) {
            return Promise.reject(new CdpError(command.method, SESSION_GONE));
        }
        return this.#connection.ask(this.#page.sessionId, command, parameters);
    }

    // Sends a command only the running page can answer. On top of what ask does, it fails at once with
    // PageHeldByDialog while a dialog is open, and as soon as one opens while it waits.
    askRunningPage<CommandParameters, Reply>(
        command: BrowserCommand<CommandParameters, Reply>,
        parameters: NoInfer<CommandParameters>,
    ): Promise<Reply> {
        if (this.#dialog !== null) {
            return Promise.reject(new PageHeldByDialog(command.method));
        }
        const opened = this.dialogOpened();
        const held = opened.promise.then((): never => {
            throw new PageHeldByDialog(command.method);
        });
        return Promise.race([this.ask(command, parameters), held]).finally(() => {
            opened.cancel();
        });
    }

    // Waits for what the browser is doing on the page's behalf, for at most as long as the page lives.
    failingOnCrash<Value>(method: string, waited: Promise<Value>): Promise<Value> {
        if (this.#crashed) {
            return Promise.reject(new CdpError(method, "the page's renderer died"));
        }
        let stopWatching = (): void => undefined;
        const crash = new Promise<never>((unusedResolve, reject) => {
            const fail = (): void => reject(new CdpError(method, "the page's renderer died"));
            stopWatching = () => {
                this.#onCrash.delete(fail);
            };
            this.#onCrash.add(fail);
        });
        return Promise.race([waited, crash]).finally(stopWatching);
    }

    #watchNavigations(): void {
        const { sessionId, targetId } = this.#page;
        const endIfTopDocument = ({ frameId }: { readonly frameId: string }): void => {
            if (frameId === targetId) {
                this.#endNavigation();
            }
        };
        this.#listen(sessionId, FRAME_REQUESTED_NAVIGATION, (requested) => {
            if (requested.frameId === targetId && requested.disposition === THIS_TAB) {
                this.#isNavigationUnderWay = true;
            }
        });
        this.#listen(sessionId, FRAME_NAVIGATED, endIfTopDocument);
        this.#listen(sessionId, NAVIGATED_WITHIN_DOCUMENT, endIfTopDocument);
        // What ends a navigation that leaves the page where it was: a download, or an empty answer.
        this.#listen(sessionId, FRAME_STOPPED_LOADING, endIfTopDocument);
    }

    #endNavigation(): void {
        this.#isNavigationUnderWay = false;
        this.#notifyNavigationWaiters();
    }

    #notifyNavigationWaiters(): void {
        for (const notify of [...this.#onNavigationEnded]) {
            notify();
        }
        this.#onNavigationEnded.clear();
    }

    #crash(): void {
        if (this.#crashed) {
            return;
        }
        this.#crashed = true;
        this.#dialog = null;
        for (const fail of [...this.#onCrash]) {
            fail();
        }
        this.#onCrash.clear();
        this.#notifyNavigationWaiters();
    }
}
