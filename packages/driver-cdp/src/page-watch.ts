// Watches one driver page from outside any command: whether its renderer has died, the dialog it
// has open, and the popups, second pages and downloads it starts. A popup or second page is held
// back from loading anything and closed, and a download is refused by the browser, so nothing of
// either is kept and no request of a popup escapes the session's allow-list; the session layer
// fails the step that started one with unsupported-step.
// Once the page has crashed, every command to it fails at once: the browser never answers a
// command sent to a dead renderer, so waiting would only run into each command's timeout.
// See docs/specs/SPEC-06-cdp-driver.md.
import { CdpError, type CdpConnection } from './cdp-connection.ts';
import type { PageEvents } from './page-operations.ts';

// Chrome DevTools Protocol event shapes this watch reads.
type TargetInfo = { readonly targetId: string; readonly type: string; readonly browserContextId?: string };
type AttachedToTarget = { readonly sessionId: string; readonly targetInfo: TargetInfo; readonly waitingForDebugger: boolean };
type TargetCrashed = { readonly targetId: string };
type DetachedFromTarget = { readonly sessionId: string };
type DialogOpening = { readonly message: string };

export type WatchedPage = { readonly browserContextId: string; readonly targetId: string; readonly sessionId: string };

export class PageWatch implements PageEvents {
  readonly #connection: CdpConnection;
  readonly #page: WatchedPage;
  #crashed = false;
  #dialog: string | null = null;
  #openings = 0;
  readonly #onCrash = new Set<() => void>();
  readonly #onDialog = new Set<() => void>();

  constructor(connection: CdpConnection, page: WatchedPage) {
    this.#connection = connection;
    this.#page = page;
  }

  // Starts listening. Called once, before the page loads anything.
  async start(): Promise<void> {
    const { browserContextId, targetId, sessionId } = this.#page;
    const connection = this.#connection;
    connection.on(sessionId, 'Inspector.targetCrashed', () => this.#crash());
    connection.on(undefined, 'Target.targetCrashed', (parameters) => {
      if ((parameters as TargetCrashed).targetId === targetId) this.#crash();
    });
    connection.on(undefined, 'Target.detachedFromTarget', (parameters) => {
      if ((parameters as DetachedFromTarget).sessionId === sessionId) this.#crash();
    });
    connection.on(sessionId, 'Page.javascriptDialogOpening', (parameters) => {
      this.#dialog = (parameters as DialogOpening).message;
      for (const notify of [...this.#onDialog]) notify();
    });
    connection.on(sessionId, 'Page.javascriptDialogClosed', () => { this.#dialog = null; });
    // Every new page is attached paused, before it loads anything. One in the session's own
    // browser context is a popup or a second page, and is closed; any other page is let run.
    connection.on(undefined, 'Target.attachedToTarget', (parameters) => {
      const attached = parameters as AttachedToTarget;
      const info = attached.targetInfo;
      if (info.type === 'page' && info.browserContextId === browserContextId && info.targetId !== targetId) {
        this.#openings += 1;
        void this.#closePopup(attached.sessionId, info.targetId);
        return;
      }
      if (attached.waitingForDebugger) connection.send(attached.sessionId, 'Runtime.runIfWaitingForDebugger').catch(() => undefined);
    });
    connection.on(undefined, 'Browser.downloadWillBegin', () => { this.#openings += 1; });
    await connection.send(sessionId, 'Inspector.enable');
    await connection.send(undefined, 'Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }] });
    // Every download is refused, so no file of one is ever written; the events still say it began.
    await connection.send(undefined, 'Browser.setDownloadBehavior', { behavior: 'deny', browserContextId, eventsEnabled: true });
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
  // it is let start, and closed.
  async #closePopup(popupSessionId: string, popupTargetId: string): Promise<void> {
    const connection = this.#connection;
    try {
      await connection.send(popupSessionId, 'Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
      await connection.send(popupSessionId, 'Runtime.runIfWaitingForDebugger');
    } catch {
      // The popup closed itself first; closing it below is then harmless.
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
