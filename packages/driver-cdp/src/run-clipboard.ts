// The own driver's clipboard port: the plain text of the headless browser's own in-memory
// clipboard. Each session launches its own browser, so the clipboard starts empty and goes with it;
// it is never the host's.
//   - The session's browser context grants clipboard writes, so a page's copy lands, and denies
//     clipboard reads, so the page's own script never reads what was copied (allowRunClipboard).
//     Each page emulates focus, which the clipboard needs in a headless browser.
//   - A read grants clipboard-read to the page's current origin for that read only, denies it again
//     straight after, and reads through an isolated world, so the page's scripts can neither see
//     the read nor change what it returns.
// See docs/specs/SPEC-34-clock-advance-and-clipboard.md.
import { failure, success, type ClipboardPort, type DriverError, type Result } from '@revisum/contracts';
import type { CdpConnection } from './cdp-connection.ts';
import { readClipboardText } from './in-page.ts';
import type { PageCommand } from './web-storage.ts';

type FrameTree = { readonly frameTree: { readonly frame: { readonly id: string; readonly securityOrigin?: string } } };
type CallResult = { readonly result: { readonly value?: unknown }; readonly exceptionDetails?: { readonly text: string } };

// The isolated script world the driver reads the clipboard through.
const CLIPBOARD_WORLD_NAME = 'driver-clipboard';
const CLIPBOARD_READ = { name: 'clipboard-read' } as const;
const CLIPBOARD_WRITE = { name: 'clipboard-write' } as const;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

// Lets every page of the browser context copy, and none read, the clipboard.
export async function allowRunClipboard(connection: CdpConnection, browserContextId: string): Promise<void> {
  await connection.send(undefined, 'Browser.setPermission', { permission: CLIPBOARD_WRITE, setting: 'granted', browserContextId });
  await connection.send(undefined, 'Browser.setPermission', { permission: CLIPBOARD_READ, setting: 'denied', browserContextId });
}

// True for an origin a permission can be granted to: a web origin, not an opaque one.
const isWebOrigin = (origin: string | undefined): origin is string => origin !== undefined && /^https?:\/\/[^/]+$/.test(origin);

export class RunClipboard implements ClipboardPort {
  readonly #connection: CdpConnection;
  readonly #browserContextId: string;
  readonly #command: PageCommand;
  readonly #crashed: () => boolean;

  // Reads through the session's first page; the clipboard is the whole browser's.
  constructor(connection: CdpConnection, browserContextId: string, command: PageCommand, crashed: () => boolean) {
    this.#connection = connection;
    this.#browserContextId = browserContextId;
    this.#command = command;
    this.#crashed = crashed;
  }

  async readText(maximumCharacters: number): Promise<Result<string, DriverError>> {
    if (this.#crashed()) return failure({ code: 'target-crashed', detail: 'the page\'s renderer died' });
    try {
      const { frameTree } = await this.#command<FrameTree>('Page.getFrameTree');
      const origin = frameTree.frame.securityOrigin;
      if (!isWebOrigin(origin)) return failure({ code: 'clipboard-unavailable', detail: 'the page has no web origin to read the clipboard for' });
      const world = await this.#command<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: CLIPBOARD_WORLD_NAME });
      await this.#setRead(origin, 'granted');
      let called: CallResult;
      try {
        called = await this.#command<CallResult>('Runtime.callFunctionOn', {
          functionDeclaration: readClipboardText.toString(), executionContextId: world.executionContextId,
          arguments: [{ value: maximumCharacters }], awaitPromise: true, returnByValue: true,
        });
      } finally {
        await this.#setRead(origin, 'denied');
      }
      const text = called.result.value;
      if (called.exceptionDetails !== undefined || typeof text !== 'string') {
        return failure({ code: 'clipboard-unavailable', detail: 'the browser did not give its clipboard\'s text' });
      }
      return success(text);
    } catch (error) {
      if (this.#crashed()) return failure({ code: 'target-crashed', detail: 'the page\'s renderer died' });
      return failure({ code: 'clipboard-unavailable', detail: `the clipboard could not be read: ${errorText(error)}` });
    }
  }

  async #setRead(origin: string, setting: 'granted' | 'denied'): Promise<void> {
    await this.#connection.send(undefined, 'Browser.setPermission', { permission: CLIPBOARD_READ, setting, origin, browserContextId: this.#browserContextId });
  }
}
