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
import { errorText } from './browser-session.ts';
import { CdpError, type CdpConnection } from './cdp-connection.ts';
import type { PageEvents } from './page-operations.ts';
import { PageHeldByDialog } from './PageHeldByDialog.ts';

// Chrome DevTools Protocol event shapes this watch reads.
type TargetInfo = { readonly targetId: string; readonly type: string; readonly browserContextId?: string; readonly openerId?: string };
type AttachedToTarget = { readonly sessionId: string; readonly targetInfo: TargetInfo; readonly waitingForDebugger: boolean };
type TargetCrashed = { readonly targetId: string };
type DetachedFromTarget = { readonly sessionId: string };
type DialogOpening = { readonly message: string };
type RequestPaused = { readonly request: { readonly url: string } };
const DOCUMENT_REQUEST = 'Document';

// How long a popup is given to ask for its first page, so that request can be recorded before the
// popup is closed. A popup opened with no address asks for nothing and is closed after this wait.
const POPUP_REQUEST_WAIT_MILLISECONDS = 1_000;
// How a command fails when a popup closed itself first, or the browser or the session has gone.
// Nothing is left to hold back then, so there is nothing to report.
const POPUP_ALREADY_GONE = /Session with given id not found|No target with given id|connection closed/i;
// A navigation that stays in this page's tab, as the browser says of one it was asked for.
const THIS_TAB = 'currentTab';

const fieldsOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {});

// A link's file, as the top of this file explains: a document asked for with no navigation behind it.
function isRequestForAFile(paused: unknown): boolean {
  const fields = fieldsOf(paused);
  return fields['resourceType'] === DOCUMENT_REQUEST && fields['networkId'] === undefined && fields['responseStatusCode'] === undefined && fields['responseErrorReason'] === undefined;
}

type WatchedPage = { readonly browserContextId: string; readonly targetId: string; readonly sessionId: string };

// A page the browser attached, still paused before it loads anything.
export type AttachedPage = { readonly targetId: string; readonly sessionId: string };

type PageWatchOptions = {
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
  readonly #onPopupRequest: (url: string) => void;
  readonly #ownsBrowserContext: boolean;
  readonly #claimsDownload: (event: unknown) => boolean;
  readonly #isDownloadStepUnderWay: () => boolean;
  // A promise per popup still being given its chance to ask for its first page.
  readonly #popupFirstRequests = new Set<Promise<void>>();
  readonly #popupFailures: string[] = [];
  // Hands the next page opened without an opener to the newTab step waiting for it.
  #tabClaim: ((page: AttachedPage) => void) | null = null;
  readonly #stopListening: (() => void)[] = [];

  constructor(connection: CdpConnection, page: WatchedPage, options: PageWatchOptions) {
    this.#connection = connection;
    this.#page = page;
    this.#onPopupRequest = options.onPopupRequest ?? (() => undefined);
    this.#ownsBrowserContext = options.ownsBrowserContext;
    this.#claimsDownload = options.claimsDownload ?? (() => false);
    this.#isDownloadStepUnderWay = options.isDownloadStepUnderWay ?? (() => false);
  }

  // Starts listening. Called once, before the page loads anything.
  async start(): Promise<void> {
    const { browserContextId, targetId, sessionId } = this.#page;
    const connection = this.#connection;
    const listen = (listenedSession: string | undefined, event: string, handler: (parameters: unknown) => void): void => {
      this.#stopListening.push(connection.on(listenedSession, event, handler));
    };
    this.#stopListening.push(connection.onLost(() => this.#crash()));
    listen(sessionId, 'Inspector.targetCrashed', () => this.#crash());
    listen(undefined, 'Target.targetCrashed', (parameters) => {
      if ((parameters as TargetCrashed).targetId === targetId) this.#crash();
    });
    listen(undefined, 'Target.detachedFromTarget', (parameters) => {
      if ((parameters as DetachedFromTarget).sessionId === sessionId) this.#crash();
    });
    listen(sessionId, 'Page.javascriptDialogOpening', (parameters) => {
      this.#dialog = (parameters as DialogOpening).message;
      for (const notify of [...this.#onDialog]) notify();
      this.#notifyNavigationWaiters();
    });
    listen(sessionId, 'Page.javascriptDialogClosed', (parameters) => {
      this.#dialog = null;
      // Dismissing what a page asks before it unloads cancels the navigation, and nothing else says so.
      if (fieldsOf(parameters)['result'] === false) {
        this.#endNavigation();
      }
    });
    this.#watchNavigations();
    // Every new page in the browser is attached paused, before it loads anything. One in the
    // session's own browser context is a popup or a second page, and is closed, unless it is the
    // tab a newTab step is waiting for. A page of another context is never let run from here: that
    // would start it before its own session has made it hold back its requests.
    listen(undefined, 'Target.attachedToTarget', (parameters) => {
      const attached = parameters as AttachedToTarget;
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
      if (attached.waitingForDebugger && info.browserContextId === browserContextId) connection.send(attached.sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => undefined);
    });
    listen(undefined, 'Browser.downloadWillBegin', (parameters) => {
      if (!this.#claimsDownload(parameters)) this.#openings += 1;
    });
    listen(sessionId, 'Fetch.requestPaused', (parameters) => {
      if (isRequestForAFile(parameters) && !this.#isDownloadStepUnderWay()) {
        this.#openings += 1;
      }
    });
    await connection.send(sessionId, 'Inspector.enable');
    if (!this.#ownsBrowserContext) return;
    await connection.send(undefined, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] });
    // Every download is refused, so no file of one is ever written; the events still say it began.
    // A download step lets the browser save the one download it claims, and refuses again after.
    await connection.send(undefined, 'Browser.setDownloadBehavior', { behavior: 'deny', browserContextId, eventsEnabled: true });
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
    await this.command('Page.handleJavaScriptDialog', { accept });
  }

  unsupportedOpenings(): number {
    return this.#openings;
  }

  // Waits until each popup open now has asked for its first page or used up its wait, so the
  // session's record of them is complete, and rejects with whatever could not be done about one.
  // Popups opened during the wait are not waited for, so a page that keeps opening them cannot
  // hold the session's close.
  async settleHeldPopups(): Promise<void> {
    await Promise.all(this.#popupFirstRequests);
    if (this.#popupFailures.length > 0) {
      throw new Error(`a popup could not be held back or closed: ${this.#popupFailures.join('; ')}`);
    }
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

  // Sends a command to the page. It fails at once on a crashed page, and as soon as the page
  // crashes while it waits.
  command<Value = Record<string, unknown>>(method: string, parameters: Record<string, unknown> = {}): Promise<Value> {
    if (this.#crashed) return Promise.reject(new CdpError(method, 'the page\'s renderer died'));
    return this.failingOnCrash(method, this.#connection.send<Value>(this.#page.sessionId, method, parameters));
  }

  // Sends a command only the running page can answer. On top of what command() does, it fails at
  // once with PageHeldByDialog while a dialog is open, and as soon as one opens while it waits.
  commandToRunningPage<Value = Record<string, unknown>>(method: string, parameters: Record<string, unknown> = {}): Promise<Value> {
    if (this.#dialog !== null) {
      return Promise.reject(new PageHeldByDialog(method));
    }
    const opened = this.dialogOpened();
    const held = opened.promise.then((): never => { throw new PageHeldByDialog(method); });
    return Promise.race([this.command<Value>(method, parameters), held]).finally(() => { opened.cancel(); });
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
    const connection = this.#connection;
    const endIfTopDocument = (frameId: unknown): void => {
      if (frameId === targetId) {
        this.#endNavigation();
      }
    };
    this.#stopListening.push(
      connection.on(sessionId, 'Page.frameRequestedNavigation', (parameters) => {
        const requested = fieldsOf(parameters);
        if (requested['frameId'] === targetId && requested['disposition'] === THIS_TAB) {
          this.#isNavigationUnderWay = true;
        }
      }),
      connection.on(sessionId, 'Page.frameNavigated', (parameters) => { endIfTopDocument(fieldsOf(fieldsOf(parameters)['frame'])['id']); }),
      connection.on(sessionId, 'Page.navigatedWithinDocument', (parameters) => { endIfTopDocument(fieldsOf(parameters)['frameId']); }),
      // What ends a navigation that leaves the page where it was: a download, or an empty answer.
      connection.on(sessionId, 'Page.frameStoppedLoading', (parameters) => { endIfTopDocument(fieldsOf(parameters)['frameId']); }),
    );
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
      const stopListening = connection.on(popupSessionId, 'Fetch.requestPaused', (parameters) => {
        this.#onPopupRequest((parameters as RequestPaused).request.url);
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
      await connection.send(popupSessionId, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      await connection.send(popupSessionId, 'Runtime.runIfWaitingForDebugger');
      await firstRequest;
    } catch (error) {
      this.#notePopupFailure(error);
    } finally {
      endWait();
      this.#popupFirstRequests.delete(firstRequest);
    }
    await connection.send(undefined, 'Target.closeTarget', { targetId: popupTargetId }).catch((error: unknown) => { this.#notePopupFailure(error); });
  }

  #notePopupFailure(error: unknown): void {
    const text = errorText(error);
    if (!POPUP_ALREADY_GONE.test(text)) {
      this.#popupFailures.push(text);
    }
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
