// The own driver's storage port: local and session storage of the session's page, through CDP's
// DOMStorage domain, so no script runs in the page. An entry belongs to one origin: a write or a
// read while the page is on another origin fails with storage-origin-mismatch and touches nothing.
// See docs/specs/SPEC-33-network-stubs-request-checks-and-storage.md.
import {
  failure, success,
  type DriverError, type Origin, type Result, type StorageArea, type StoragePort,
} from '@revisum/contracts';

// Chrome DevTools Protocol answer shapes this port reads.
type FrameTree = { readonly frameTree: { readonly frame: { readonly url: string; readonly securityOrigin?: string } } };
type StorageItems = { readonly entries: readonly (readonly string[])[] };

// Sends a command to the page, failing at once when its renderer has died.
export type PageCommand = <Value>(method: string, parameters?: Record<string, unknown>) => Promise<Value>;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200);

export class PageStorage implements StoragePort {
  readonly #command: PageCommand;
  readonly #crashed: () => boolean;

  constructor(command: PageCommand, crashed: () => boolean) {
    this.#command = command;
    this.#crashed = crashed;
  }

  async write(area: StorageArea, origin: Origin, key: string, value: string): Promise<Result<void, DriverError>> {
    return this.#onOrigin(area, origin, async (storageId) => {
      await this.#command('DOMStorage.setDOMStorageItem', { storageId, key, value });
    });
  }

  async remove(area: StorageArea, origin: Origin, key: string): Promise<Result<void, DriverError>> {
    return this.#onOrigin(area, origin, async (storageId) => {
      await this.#command('DOMStorage.removeDOMStorageItem', { storageId, key });
    });
  }

  async read(area: StorageArea, origin: Origin, key: string): Promise<Result<string | null, DriverError>> {
    return this.#onOrigin(area, origin, async (storageId) => {
      const items = await this.#command<StorageItems>('DOMStorage.getDOMStorageItems', { storageId });
      const entry = items.entries.find((candidate) => candidate[0] === key);
      return entry?.[1] ?? null;
    });
  }

  // Runs the storage command only when the page is on the entry's origin.
  async #onOrigin<Value>(
    area: StorageArea, origin: Origin, use: (storageId: { readonly securityOrigin: string; readonly isLocalStorage: boolean }) => Promise<Value>,
  ): Promise<Result<Value, DriverError>> {
    try {
      const shown = await this.#pageOrigin();
      if (shown !== origin) return failure({ code: 'storage-origin-mismatch', detail: 'the page is not on the storage entry\'s origin' });
      return success(await use({ securityOrigin: origin, isLocalStorage: area === 'local' }));
    } catch (error) {
      return failure(this.#crashed() ? { code: 'target-crashed', detail: 'the page\'s renderer died' } : { code: 'not-actionable', detail: errorText(error) });
    }
  }

  // The origin of the page's top document, or null when it has none, such as about:blank.
  async #pageOrigin(): Promise<string | null> {
    const tree = await this.#command<FrameTree>('Page.getFrameTree');
    const frame = tree.frameTree.frame;
    if (frame.securityOrigin !== undefined && frame.securityOrigin !== '' && frame.securityOrigin !== 'null') return frame.securityOrigin;
    try {
      const origin = new URL(frame.url).origin;
      return origin === 'null' ? null : origin;
    } catch {
      return null;
    }
  }
}
