// Watches one driver page from outside any command: whether its renderer has died, the dialog it
// has open, whether its top document is on its way to another, and the popups, second pages and
// downloads it starts. A popup or second page is held
// back from loading anything and closed, and a download is refused by the browser, so nothing of
// either is kept and no request of a popup escapes the session's allow-list; the session layer
// fails the step that started one with unsupported-step. Two openings are not counted: the
// download a download step claimed, and the tab a newTab step asked for, which is handed over
// still paused, before it loads anything.
// The browser says a download has begun only once its server answers, which may be after the run has
// ended. A link with the download attribute says so sooner: the browser asks for its file as it asks
// for a document, with no frame's navigation behind the request, so the Network domain has no id for
// it. Every frame's navigation has one, whoever started it.
// Once the page has crashed, every command to it fails at once: the browser never answers a
// command sent to a dead renderer, so waiting would only run into each command's timeout. A browser
// that dies or a connection that closes takes the page with it, so both count as a crash.
// Once a dialog is open, every command that needs the page fails at once in the same way, and one
// under way fails as the dialog opens, so this is the one place that dialog state is read for them.
// A request stays held until the browser takes the driver's decision on it, so a decision it refuses
// is held here too, whenever its answer comes, for whatever reports next.
import { errorText } from './browser-session.ts';
import { ATTACHED_TO_TARGET, DETACHED_FROM_TARGET, DIALOG_CLOSED, DIALOG_OPENING, FRAME_NAVIGATED, FRAME_REQUESTED_NAVIGATION, FRAME_STOPPED_LOADING, NAVIGATED_WITHIN_DOCUMENT, REQUEST_PAUSED, TARGET_CRASHED, type BrowserEvent, type RequestPaused } from './BrowserEvent.ts';
import { CLOSE_TARGET, ENABLE_INSPECTOR, HANDLE_DIALOG, SET_AUTO_ATTACH, SET_DOWNLOAD_BEHAVIOUR, type BrowserCommand } from './BrowserCommand.ts';
import { ENABLE_REQUEST_HOLDING } from './DispatchMouseEvent.ts';
import { RUN_IF_WAITING_FOR_DEBUGGER } from './CallFunctionOn.ts';
import { CdpError, type CdpConnection } from './cdp-connection.ts';
import type { PageEvents } from './page-operations.ts';
import { PageHeldByDialog } from './PageHeldByDialog.ts';

const DOCUMENT_REQUEST = 'Document';

// How long a popup is given to ask for its first page, so that request can be recorded before the
// popup is closed. A popup opened with no address asks for nothing and is closed after this wait.
const POPUP_REQUEST_WAIT_MILLISECONDS = 1_000;
// How a command fails when a target closed itself first, or the browser or the session has gone.
// Nothing is left to act on then, so there is nothing to report.
const TARGET_ALREADY_GONE = /Session with given id not found|No target with given id|connection closed/i;
// How a decision on a request fails when nothing is held any more: the page gave up on the request or
// died, its tab or browser context has gone, or the session has closed. Each is the browser's exact
// answer, so no other refusal can pass for one.
const REQUEST_NO_LONGER_HELD = /^Fetch\.\w+: (?:Invalid InterceptionId\.|Session with given id not found\.|connection closed)$/;
// A navigation that stays in this page's tab, as the browser says of one it was asked for.
const THIS_TAB = 'currentTab';

// A link's file, as the top of this file explains: a document asked for with no navigation behind it.
const isRequestForAFile = (paused: RequestPaused): boolean =>
  paused.stage === 'request' && paused.resourceType === DOCUMENT_REQUEST && paused.networkId === undefined;

type WatchedPage = { readonly browserContextId: string; readonly targetId: string; readonly sessionId: string };

// What every page of one session holds together, so a tab that closes takes none of it with it.
export type SessionFailures = {
  readonly refusedDecisions: string[];
  readonly cleanUp: string[];
};

// What a held request's decision depends on may be in an event the driver cannot read, and what comes
// after it says no more than after a refused decision, so it is kept with those.
export const holdUnreadableEvent = (failures: SessionFailures) => (detail: string): void => {
  failures.refusedDecisions.push(`the driver could not read what the browser said, so it decided nothing on it: ${detail}`);
};

// A page the browser attached, still paused before it loads anything.
export type AttachedPage = { readonly targetId: string; readonly sessionId: string };

type PageWatchOptions = {
  readonly failures: SessionFailures;
  // Told the address each held-back popup asked for.
  readonly onPopupRequest?: (url: string) => void;
  // True for the session's first page, which sets up what the whole browser context shares:
  // attaching every new page paused, and refusing downloads. A second tab's watch leaves it be.
  readonly ownsBrowserContext: boolean;
  // Asked about every download the browser starts: true when a download step claimed it, so it
  // is not an unrequested opening.
  readonly claimsDownload?: (event: unknown) => boolean;
  // True while a download step is waiting for its file, which then decides what each one is.
  readonly isDownloadStepUnderWay?: () => boolean;
};

export class PageWatch implements PageEvents {
  readonly #connection: CdpConnection;
  readonly #page: WatchedPage;
  #crashed = false;
  #dialog: string | null = null;
  #openings = 0;
  #isNavigationUnderWay = false;
  readonly #onCrash = new Set<() => void>();
  readonly #onDialog = new Set<() => void>();
  readonly #onNavigationEnded = new Set<() => void>();
  readonly #onDecisionRefused = new Set<(refusal: string) => void>();
  readonly #failures: SessionFailures;
  readonly #onPopupRequest: (url: string) => void;
  readonly #ownsBrowserContext: boolean;
  readonly #claimsDownload: (event: unknown) => boolean;
  readonly #isDownloadStepUnderWay: () => boolean;
  // A promise per popup still being given its chance to ask for its first page.
  readonly #popupFirstRequests = new Set<Promise<void>>();
  #pressCount = 0;
  // Hands the next page opened without an opener to the newTab step waiting for it.
  #tabClaim: ((page: AttachedPage) => void) | null = null;
  readonly #stopListening: (() => void)[] = [];

  constructor(connection: CdpConnection, page: WatchedPage, options: PageWatchOptions) {
    this.#connection = connection;
    this.#page = page;
    this.#failures = options.failures;
    this.#onPopupRequest = options.onPopupRequest ?? (() => undefined);
    this.#ownsBrowserContext = options.ownsBrowserContext;
    this.#claimsDownload = options.claimsDownload ?? (() => false);
    this.#isDownloadStepUnderWay = options.isDownloadStepUnderWay ?? (() => false);
  }

  // Starts listening. Called once, before the page loads anything.
  async start(): Promise<void> {
    const { browserContextId, targetId, sessionId } = this.#page;
    const connection = this.#connection;
    this.#stopListening.push(connection.onLost(() => { this.#crash(); }));
    this.#stopListening.push(connection.on(sessionId, 'Inspector.targetCrashed', () => { this.#crash(); }));
    this.#listen(undefined, TARGET_CRASHED, (crashed) => {
      if (crashed.targetId === targetId) this.#crash();
    });
    this.#listen(undefined, DETACHED_FROM_TARGET, (detached) => {
      if (detached.sessionId === sessionId) this.#crash();
    });
    this.#listen(sessionId, DIALOG_OPENING, (opening) => {
      this.#dialog = opening.message;
      for (const notify of [...this.#onDialog]) notify();
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
    // Every new page in the browser is attached paused, before it loads anything. One in the
    // session's own browser context is a popup or a second page, and is closed, unless it is the
    // tab a newTab step is waiting for. A page of another context is never let run from here: that
    // would start it before its own session has made it hold back its requests.
    this.#listen(undefined, ATTACHED_TO_TARGET, (attached) => {
      const info = attached.targetInfo;
      if (info.type === 'page' && info.browserContextId === browserContextId && info.targetId !== targetId) {
        const claim = this.#tabClaim;
        if (claim !== null && info.openerId === undefined) {
          this.#tabClaim = null;
          claim({ targetId: info.targetId, sessionId: attached.sessionId });
          return;
        }
        this.#openings += 1;
        void this.#closePopup(attached.sessionId, info.targetId);
        return;
      }
      if (attached.waitingForDebugger && info.browserContextId === browserContextId) {
        connection.ask(attached.sessionId, RUN_IF_WAITING_FOR_DEBUGGER, {}).catch((error: unknown) => { this.noteTargetFailure('a new target could not be let run', error); });
      }
    });
    // Read by the download folder, which treats whatever it cannot read as a download nobody claimed.
    this.#stopListening.push(connection.on(undefined, 'Browser.downloadWillBegin', (parameters) => {
      if (!this.#claimsDownload(parameters)) this.#openings += 1;
    }));
    await connection.ask(sessionId, ENABLE_INSPECTOR, {});
    if (!this.#ownsBrowserContext) return;
    await connection.ask(undefined, SET_AUTO_ATTACH, { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] });
    // Every download is refused, so no file of one is ever written; the events still say it began.
    // A download step lets the browser save the one download it claims, and refuses again after.
    await connection.ask(undefined, SET_DOWNLOAD_BEHAVIOUR, { behavior: 'deny', browserContextId, eventsEnabled: true });
  }

  #listen<Payload>(listenedSession: string | undefined, event: BrowserEvent<Payload>, handler: (payload: Payload) => void): void {
    this.#stopListening.push(this.#connection.listen(listenedSession, event, handler, (detail) => { this.noteUnreadableEvent(detail); }));
  }

  // The id of the next press in this page, so what its check reports is told from any other's.
  nextPressId(): string {
    this.#pressCount += 1;
    return `press-${this.#pressCount}`;
  }

  // Stops listening, once the page is closed.
  stop(): void {
    for (const stopListening of this.#stopListening.splice(0)) stopListening();
    this.#tabClaim = null;
    this.#notifyNavigationWaiters();
  }

  // Resolves with the next page the browser context opens without an opener, still paused, which
  // the caller then prepares and lets run. It is not counted as an opening and not closed.
  nextTab(timeoutMilliseconds: number): { readonly promise: Promise<AttachedPage>; cancel(): void } {
    let timer: NodeJS.Timeout | undefined;
    const promise = new Promise<AttachedPage>((resolve, reject) => {
      this.#tabClaim = (page) => { clearTimeout(timer); resolve(page); };
      timer = setTimeout(() => {
        this.#tabClaim = null;
        reject(new Error(`no new tab attached within ${timeoutMilliseconds} ms`));
      }, timeoutMilliseconds);
    });
    return { promise, cancel: () => { clearTimeout(timer); this.#tabClaim = null; } };
  }

  crashed(): boolean {
    return this.#crashed;
  }

  openDialog(): string | null {
    return this.#dialog;
  }

  async answerDialog(accept: boolean): Promise<void> {
    await this.ask(HANDLE_DIALOG, { accept });
  }

  unsupportedOpenings(): number {
    return this.#openings;
  }

  refusedRequestDecisions(): readonly string[] {
    return [...this.#failures.refusedDecisions];
  }

  // Waits until each popup open now has asked for its first page or used up its wait, so the
  // session's record of them is complete, and rejects with every clean-up that failed, in any tab.
  // Popups opened during the wait are not waited for, so a page that keeps opening them cannot hold
  // the session's close.
  async settleHeldPopupsAndReportCleanUp(): Promise<void> {
    await Promise.all(this.#popupFirstRequests);
    if (this.#failures.cleanUp.length > 0) {
      throw new Error(this.#failures.cleanUp.join('; '));
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
    this.#holdRefusal(`the driver could not read what the browser said, so it decided nothing on it: ${detail}`);
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
    return this.#connection.listen(pausedSessionId, REQUEST_PAUSED, (paused) => {
      if (pausedSessionId === this.#page.sessionId && isRequestForAFile(paused) && !this.#isDownloadStepUnderWay()) {
        this.#openings += 1;
      }
      handler(paused);
    }, (detail) => { this.#holdRefusal(`the driver could not read a request the browser holds, so it decided nothing on it: ${detail}`); });
  }

  // Waits for what cannot end while this page's requests stay held, such as its load, for at most
  // until the browser refuses a decision on one of them.
  failingOnRefusedDecision<Value>(waited: Promise<Value>): Promise<Value> {
    const refused = Promise.withResolvers<never>();
    const fail = (refusal: string): void => { refused.reject(new Error(refusal)); };
    this.#onDecisionRefused.add(fail);
    return Promise.race([waited, refused.promise]).finally(() => { this.#onDecisionRefused.delete(fail); });
  }

  // Resolves as soon as a dialog is open, at once when one already is.
  dialogOpened(): { readonly promise: Promise<void>; cancel(): void } {
    let notify = (): void => undefined;
    const promise = new Promise<void>((resolve) => {
      if (this.#dialog !== null) { resolve(); return; }
      notify = () => { this.#onDialog.delete(notify); resolve(); };
      this.#onDialog.add(notify);
    });
    return { promise, cancel: () => { this.#onDialog.delete(notify); } };
  }

  // Resolves once the top document is not on its way to another, or a dialog or a crash has stopped
  // it from getting there: at once when it is not. A press sends its navigation before the browser
  // has anything to show for it, and the old page goes on answering meanwhile.
  navigationEnded(): Promise<void> {
    if (!this.#isNavigationUnderWay || this.#dialog !== null || this.#crashed) {
      return Promise.resolve();
    }
    return new Promise((resolve) => { this.#onNavigationEnded.add(resolve); });
  }

  // Sends a command to the page, with its reply parsed before anyone sees it. It fails at once on a
  // crashed page, and as soon as the page crashes while it waits.
  ask<CommandParameters, Reply>(command: BrowserCommand<CommandParameters, Reply>, parameters: NoInfer<CommandParameters>): Promise<Reply> {
    if (this.#crashed) return Promise.reject(new CdpError(command.method, 'the page\'s renderer died'));
    return this.failingOnCrash(command.method, this.#connection.ask(this.#page.sessionId, command, parameters));
  }

  // Sends a command only the running page can answer. On top of what ask does, it fails at once with
  // PageHeldByDialog while a dialog is open, and as soon as one opens while it waits.
  askRunningPage<CommandParameters, Reply>(command: BrowserCommand<CommandParameters, Reply>, parameters: NoInfer<CommandParameters>): Promise<Reply> {
    if (this.#dialog !== null) {
      return Promise.reject(new PageHeldByDialog(command.method));
    }
    const opened = this.dialogOpened();
    const held = opened.promise.then((): never => { throw new PageHeldByDialog(command.method); });
    return Promise.race([this.ask(command, parameters), held]).finally(() => { opened.cancel(); });
  }

  // Waits for what the browser is doing on the page's behalf, for at most as long as the page lives.
  failingOnCrash<Value>(method: string, waited: Promise<Value>): Promise<Value> {
    if (this.#crashed) {
      return Promise.reject(new CdpError(method, 'the page\'s renderer died'));
    }
    let stopWatching = (): void => undefined;
    const crash = new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(new CdpError(method, 'the page\'s renderer died'));
      stopWatching = () => { this.#onCrash.delete(fail); };
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

  // A popup that can reach its opener shares the opener's renderer process, so while it waits to
  // start, the opener waits too. Its every request is held back first, so it loads nothing; then
  // it is let start, its first request (held back) is recorded, and it is closed.
  async #closePopup(popupSessionId: string, popupTargetId: string): Promise<void> {
    const connection = this.#connection;
    let endWait = (): void => undefined;
    // Its own timer settles it, whatever the commands below do, and the session's close awaits it.
    const firstRequest = new Promise<void>((resolve) => {
      const timer = setTimeout(() => { endWait(); }, POPUP_REQUEST_WAIT_MILLISECONDS);
      const stopListening = this.onRequestPaused(popupSessionId, (paused) => {
        this.#onPopupRequest(paused.request.url);
        endWait();
      });
      endWait = () => {
        clearTimeout(timer);
        stopListening();
        resolve();
      };
    });
    this.#popupFirstRequests.add(firstRequest);
    try {
      await connection.ask(popupSessionId, ENABLE_REQUEST_HOLDING, { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      await connection.ask(popupSessionId, RUN_IF_WAITING_FOR_DEBUGGER, {});
      await firstRequest;
    } catch (error) {
      this.noteTargetFailure('a popup could not be held back', error);
    } finally {
      endWait();
      this.#popupFirstRequests.delete(firstRequest);
    }
    await connection.ask(undefined, CLOSE_TARGET, { targetId: popupTargetId }).catch((error: unknown) => { this.noteTargetFailure('a popup could not be closed', error); });
  }

  #crash(): void {
    if (this.#crashed) return;
    this.#crashed = true;
    this.#dialog = null;
    for (const fail of [...this.#onCrash]) fail();
    this.#onCrash.clear();
    this.#notifyNavigationWaiters();
  }
}
