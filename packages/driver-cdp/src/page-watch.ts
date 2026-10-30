// Watches one driver page from outside any command: whether its renderer has died, the dialog it
// has open, and the popups, second pages and downloads it starts. A popup or second page is held
// back from loading anything and closed, and a download is refused by the browser, so nothing of
// either is kept and no request of a popup escapes the session's allow-list; the session layer
// fails the step that started one with unsupported-step. Two openings are not counted: the
// download a download step claimed, and the tab a newTab step asked for, which is handed over
// still paused, before it loads anything.
// Once the page has crashed, every command to it fails at once: the browser never answers a
// command sent to a dead renderer, so waiting would only run into each command's timeout.
// See docs/specs/SPEC-06-cdp-driver.md.
import { CdpError, type CdpConnection } from './cdp-connection.ts';
import type { PageEvents } from './page-operations.ts';

// Chrome DevTools Protocol event shapes this watch reads.
type TargetInfo = { readonly targetId: string; readonly type: string; readonly browserContextId?: string; readonly openerId?: string };
type AttachedToTarget = { readonly sessionId: string; readonly targetInfo: TargetInfo; readonly waitingForDebugger: boolean };
type TargetCrashed = { readonly targetId: string };
type DetachedFromTarget = { readonly sessionId: string };
type DialogOpening = { readonly message: string };
type RequestPaused = { readonly request: { readonly url: string } };

// How long a popup is given to ask for its first page, so that request can be recorded before the
// popup is closed. A popup opened with no address asks for nothing and is closed after this wait.
const POPUP_REQUEST_WAIT_MILLISECONDS = 1_000;

export type WatchedPage = { readonly browserContextId: string; readonly targetId: string; readonly sessionId: string };

// A page the browser attached, still paused before it loads anything.
export type AttachedPage = { readonly targetId: string; readonly sessionId: string };

export type PageWatchOptions = {
  // Told the address each held-back popup asked for.
  readonly onPopupRequest?: (url: string) => void;
  // True for the session's first page, which sets up what the whole browser context shares:
  // attaching every new page paused, and refusing downloads. A second tab's watch leaves it be.
  readonly ownsBrowserContext: boolean;
  // Asked about every download the browser starts: true when a download step claimed it, so it
  // is not an unrequested opening.
  readonly claimsDownload?: (event: unknown) => boolean;
};

export class PageWatch implements PageEvents {
  readonly #connection: CdpConnection;
  readonly #page: WatchedPage;
  #crashed = false;
  #dialog: string | null = null;
  #openings = 0;
  readonly #onCrash = new Set<() => void>();
  readonly #onDialog = new Set<() => void>();
  readonly #onPopupRequest: (url: string) => void;
  readonly #ownsBrowserContext: boolean;
  readonly #claimsDownload: (event: unknown) => boolean;
  // Hands the next page opened without an opener to the newTab step waiting for it.
  #tabClaim: ((page: AttachedPage) => void) | null = null;
  readonly #stopListening: (() => void)[] = [];

  constructor(connection: CdpConnection, page: WatchedPage, options: PageWatchOptions) {
    this.#connection = connection;
    this.#page = page;
    this.#onPopupRequest = options.onPopupRequest ?? (() => undefined);
    this.#ownsBrowserContext = options.ownsBrowserContext;
    this.#claimsDownload = options.claimsDownload ?? (() => false);
  }

  // Starts listening. Called once, before the page loads anything.
  async start(): Promise<void> {
    const { browserContextId, targetId, sessionId } = this.#page;
    const connection = this.#connection;
    const listen = (listenedSession: string | undefined, event: string, handler: (parameters: unknown) => void): void => {
      this.#stopListening.push(connection.on(listenedSession, event, handler));
    };
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
    });
    listen(sessionId, 'Page.javascriptDialogClosed', () => { this.#dialog = null; });
    // Every new page is attached paused, before it loads anything. One in the session's own
    // browser context is a popup or a second page, and is closed, unless it is the tab a newTab
    // step is waiting for; any other page is let run.
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
      if (attached.waitingForDebugger) connection.send(attached.sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => undefined);
    });
    listen(undefined, 'Browser.downloadWillBegin', (parameters) => {
      if (!this.#claimsDownload(parameters)) this.#openings += 1;
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

  // Sends a command to the page. It fails at once on a crashed page, and as soon as the page
  // crashes while it waits.
  command<Value = Record<string, unknown>>(method: string, parameters: Record<string, unknown> = {}): Promise<Value> {
    if (this.#crashed) return Promise.reject(new CdpError(method, 'the page\'s renderer died'));
    const sent = this.#connection.send<Value>(this.#page.sessionId, method, parameters);
    let stopWatching = (): void => undefined;
    const crash = new Promise<never>((_resolve, reject) => {
      const fail = (): void => reject(new CdpError(method, 'the page\'s renderer died'));
      stopWatching = () => { this.#onCrash.delete(fail); };
      this.#onCrash.add(fail);
    });
    return Promise.race([sent, crash]).finally(stopWatching);
  }

  // A popup that can reach its opener shares the opener's renderer process, so while it waits to
  // start, the opener waits too. Its every request is held back first, so it loads nothing; then
  // it is let start, its first request (held back) is recorded, and it is closed.
  async #closePopup(popupSessionId: string, popupTargetId: string): Promise<void> {
    const connection = this.#connection;
    let stopListening = (): void => undefined;
    let timer: NodeJS.Timeout | undefined;
    const firstRequest = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, POPUP_REQUEST_WAIT_MILLISECONDS);
      stopListening = connection.on(popupSessionId, 'Fetch.requestPaused', (parameters) => {
        stopListening();
        this.#onPopupRequest((parameters as RequestPaused).request.url);
        resolve();
      });
    });
    try {
      await connection.send(popupSessionId, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      await connection.send(popupSessionId, 'Runtime.runIfWaitingForDebugger');
      await firstRequest;
    } catch {
      // The popup closed itself first; closing it below is then harmless.
    } finally {
      clearTimeout(timer);
      stopListening();
    }
    await connection.send(undefined, 'Target.closeTarget', { targetId: popupTargetId }).catch(() => undefined);
  }

  #crash(): void {
    if (this.#crashed) return;
    this.#crashed = true;
    this.#dialog = null;
    for (const fail of [...this.#onCrash]) fail();
    this.#onCrash.clear();
  }
}
