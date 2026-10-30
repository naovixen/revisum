// The downloads a session's download steps ask for. The browser refuses every download, except
// while a download step waits for the one its click starts: then it saves that one file into a
// folder the session made for itself under the system's temporary folder, under the download's
// generated id, never the name the server sent. The server's name is kept only as text, with path
// separators and control characters replaced. A file over the step's byte limit is cancelled and
// its partial bytes deleted; a second download in the same step is cancelled the same way. The
// folder and every file in it are removed when the session closes.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import { failure, success, type DownloadedFile, type DriverError, type Result } from '@revisum/contracts';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CdpConnection } from './cdp-connection.ts';
import type { ArmedDownload, DownloadCapture } from './page-operations.ts';

// What the browser says about a download, decoded from its events.
type DownloadBegun = { readonly downloadId: string; readonly url: string; readonly suggestedFilename: string };
type DownloadState = 'inProgress' | 'completed' | 'canceled';
type DownloadProgress = { readonly downloadId: string; readonly receivedBytes: number; readonly state: DownloadState };

// The one download an armed step claimed, as it goes.
type ClaimedDownload = DownloadBegun & { state: DownloadState; receivedBytes: number };

type Armed = { claimed: ClaimedDownload | null; kept: boolean };

const FOLDER_PREFIX = 'browser-downloads-';
const POLL_INTERVAL_MILLISECONDS = 50;
// How long a cancelled download is given to stop writing before its bytes are deleted.
const CANCEL_WAIT_MILLISECONDS = 2_000;
// A download that has started is given at least this long to finish.
const SHORTEST_FINISH_MILLISECONDS = 30_000;
// The media type of a download whose response the session did not see, such as a blob.
const UNKNOWN_MEDIA_TYPE = 'application/octet-stream';
const LONGEST_FILE_NAME = 255;
// The browser's download ids (its "guid" field). Nothing else is ever used as a file name in the folder.
const DOWNLOAD_ID = /^[0-9A-Za-z-]{8,64}$/;
const STATES: readonly DownloadState[] = ['inProgress', 'completed', 'canceled'];

const pause = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
const fieldsOf = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? value as Record<string, unknown> : {});

function decodeBegun(event: unknown): DownloadBegun | undefined {
  const fields = fieldsOf(event);
  const [downloadId, url, suggestedFilename] = [fields['guid'], fields['url'], fields['suggestedFilename']];
  if (typeof downloadId !== 'string' || !DOWNLOAD_ID.test(downloadId) || typeof url !== 'string' || typeof suggestedFilename !== 'string') return undefined;
  return { downloadId, url, suggestedFilename };
}

function decodeProgress(event: unknown): DownloadProgress | undefined {
  const fields = fieldsOf(event);
  const [downloadId, receivedBytes, state] = [fields['guid'], fields['receivedBytes'], fields['state']];
  const known = STATES.find((candidate) => candidate === state);
  if (typeof downloadId !== 'string' || typeof receivedBytes !== 'number' || known === undefined) return undefined;
  return { downloadId, receivedBytes, state: known };
}

// The URL and media type of a response the page received.
function decodeResponse(event: unknown): { readonly url: string; readonly mediaType: string } | undefined {
  const response = fieldsOf(fieldsOf(event)['response']);
  const [url, mimeType] = [response['url'], response['mimeType']];
  return typeof url === 'string' && typeof mimeType === 'string' && mimeType !== '' ? { url, mediaType: mimeType } : undefined;
}

// The server's suggested name as text only: no path separator or control character survives, so
// it can be compared but could never lead anywhere if someone did use it as a path.
export function downloadFileName(suggested: string): string {
  const replaced = suggested.replace(/[\\/\u0000-\u001f\u007f]/g, '_').slice(0, LONGEST_FILE_NAME);
  return replaced === '' ? 'download' : replaced;
}

export class DownloadFolder implements DownloadCapture {
  readonly #connection: CdpConnection;
  readonly #browserContextId: string;
  #folder: string | null = null;
  #armed: Armed | null = null;
  // The media type of each response the session's pages received while a step was armed, by URL.
  readonly #mediaTypes = new Map<string, string>();
  // The last state the browser reported for each download, so a cancelled one is known to have stopped.
  readonly #states = new Map<string, DownloadState>();

  constructor(connection: CdpConnection, browserContextId: string) {
    this.#connection = connection;
    this.#browserContextId = browserContextId;
    connection.on(undefined, 'Browser.downloadProgress', (parameters) => {
      const progress = decodeProgress(parameters);
      if (progress === undefined) return;
      this.#states.set(progress.downloadId, progress.state);
      const claimed = this.#armed?.claimed;
      if (claimed === undefined || claimed === null || claimed.downloadId !== progress.downloadId) return;
      claimed.state = progress.state;
      claimed.receivedBytes = Math.max(claimed.receivedBytes, progress.receivedBytes);
    });
  }

  // Asked by every page watch of the session about each download the browser starts. True when
  // it is the download the armed step claims; any other download while a step is armed is
  // cancelled and its bytes deleted, and counts as one no step asked for.
  claims(event: unknown): boolean {
    const begun = decodeBegun(event);
    const armed = this.#armed;
    if (begun === undefined || armed === null) return false;
    if (armed.claimed === null) {
      armed.claimed = { ...begun, state: 'inProgress', receivedBytes: 0 };
      return true;
    }
    if (armed.claimed.downloadId === begun.downloadId) return true;
    void this.#discard(begun.downloadId);
    return false;
  }

  // Notes the media type of each response a page of the session receives while a step is armed;
  // the download's own response says what the file is. Returns how to stop.
  watchResponses(sessionId: string): () => void {
    return this.#connection.on(sessionId, 'Network.responseReceived', (parameters) => {
      if (this.#armed === null) return;
      const response = decodeResponse(parameters);
      if (response !== undefined) this.#mediaTypes.set(response.url, response.mediaType);
    });
  }

  async arm(): Promise<ArmedDownload> {
    const folder = this.#ensureFolder();
    const armed: Armed = { claimed: null, kept: false };
    this.#mediaTypes.clear();
    this.#armed = armed;
    await this.#behave({ behavior: 'allowAndName', downloadPath: folder });
    return {
      finish: (maximumBytes, beginTimeoutMilliseconds) => this.#finish(armed, folder, maximumBytes, beginTimeoutMilliseconds),
      release: (keep) => this.#release(armed, keep),
    };
  }

  // Removes the folder and every file in it. Called once the browser has stopped.
  remove(): void {
    const folder = this.#folder;
    this.#folder = null;
    // 'maxRetries' is Node's own option name.
    if (folder !== null) rmSync(folder, { recursive: true, force: true, 'maxRetries': 5, retryDelay: 200 });
  }

  #ensureFolder(): string {
    if (this.#folder === null) this.#folder = mkdtempSync(join(tmpdir(), FOLDER_PREFIX));
    return this.#folder;
  }

  async #behave(behaviour: Record<string, unknown>): Promise<void> {
    await this.#connection.send(undefined, 'Browser.setDownloadBehavior', { ...behaviour, browserContextId: this.#browserContextId, eventsEnabled: true });
  }

  async #finish(armed: Armed, folder: string, maximumBytes: number, beginTimeoutMilliseconds: number): Promise<Result<DownloadedFile, DriverError>> {
    const beginBy = Date.now() + beginTimeoutMilliseconds;
    while (armed.claimed === null) {
      if (Date.now() >= beginBy) return failure({ code: 'no-download', detail: `the click started no download within ${beginTimeoutMilliseconds} ms` });
      await pause(POLL_INTERVAL_MILLISECONDS);
    }
    const claimed = armed.claimed;
    const finishBy = Date.now() + Math.max(beginTimeoutMilliseconds, SHORTEST_FINISH_MILLISECONDS);
    const tooLarge: DriverError = { code: 'download-too-large', detail: `the file is larger than ${maximumBytes} bytes` };
    // The bytes on disk are watched as well as the browser's progress events, which it sends
    // only now and then, so a file over the limit is stopped soon after it passes it.
    while (claimed.state !== 'completed') {
      if (claimed.state === 'canceled') {
        await this.#discard(claimed.downloadId);
        return failure({ code: 'no-download', detail: 'the download was cancelled before it finished' });
      }
      if (Math.max(claimed.receivedBytes, this.#bytesOnDisk(folder, claimed.downloadId)) > maximumBytes) {
        await this.#discard(claimed.downloadId);
        return failure(tooLarge);
      }
      if (Date.now() >= finishBy) {
        await this.#discard(claimed.downloadId);
        return failure({ code: 'timeout', detail: 'the download did not finish in time' });
      }
      await pause(POLL_INTERVAL_MILLISECONDS);
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(folder, claimed.downloadId));
    } catch {
      return failure({ code: 'no-download', detail: 'the browser kept no file for the download' });
    }
    if (bytes.length > maximumBytes) {
      this.#deleteBytes(folder, claimed.downloadId);
      return failure(tooLarge);
    }
    armed.kept = true;
    return success({
      fileName: downloadFileName(claimed.suggestedFilename),
      mediaType: this.#mediaTypes.get(claimed.url) ?? UNKNOWN_MEDIA_TYPE,
      bytes: new Uint8Array(bytes),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  // Refuses downloads again. A claimed file the step did not keep is cancelled and deleted.
  async #release(armed: Armed, keep: boolean): Promise<void> {
    if (this.#armed === armed) this.#armed = null;
    const claimed = armed.claimed;
    if (claimed !== null && !(keep && armed.kept)) await this.#discard(claimed.downloadId);
    await this.#behave({ behavior: 'deny' }).catch(() => undefined);
  }

  // Cancels a download, waits for the browser to stop writing it, and deletes its bytes.
  async #discard(downloadId: string): Promise<void> {
    const folder = this.#folder;
    if (this.#states.get(downloadId) !== 'completed') {
      // The quoted key is the protocol's own parameter name.
      await this.#connection.send(undefined, 'Browser.cancelDownload', { 'guid': downloadId, browserContextId: this.#browserContextId }).catch(() => undefined);
      const stopBy = Date.now() + CANCEL_WAIT_MILLISECONDS;
      while (this.#states.get(downloadId) !== 'canceled' && this.#states.get(downloadId) !== 'completed' && Date.now() < stopBy) await pause(POLL_INTERVAL_MILLISECONDS);
    }
    this.#states.delete(downloadId);
    if (folder !== null) this.#deleteBytes(folder, downloadId);
  }

  // The bytes of the download's files in the folder: the file, and any partial file beside it.
  #bytesOnDisk(folder: string, downloadId: string): number {
    let total = 0;
    for (const entry of this.#entriesOf(folder, downloadId)) {
      try { total += statSync(join(folder, entry)).size; } catch { /* written and moved meanwhile */ }
    }
    return total;
  }

  #deleteBytes(folder: string, downloadId: string): void {
    for (const entry of this.#entriesOf(folder, downloadId)) rmSync(join(folder, entry), { force: true });
  }

  #entriesOf(folder: string, downloadId: string): readonly string[] {
    try {
      return readdirSync(folder).filter((entry) => entry.startsWith(downloadId));
    } catch {
      return [];
    }
  }
}
