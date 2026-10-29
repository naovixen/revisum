// Builds zip archives in memory for the trace decoder's tests, so no binary fixture is committed:
// well-formed Playwright trace archives, and hostile ones (a zip bomb, entry names that leave the
// archive, too many entries, a truncated file, an unknown trace version).
//
// The writer follows the zip format's three parts: a local header and the data for each entry,
// then a central directory listing every entry, then the end-of-central-directory record that
// says where the directory starts. A test may make any header lie about an entry's size, as a
// zip bomb does. See docs/specs/SPEC-35-evidence-mode.md.
import { Buffer } from 'node:buffer';
import { crc32, deflateRawSync } from 'node:zlib';

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_DIRECTORY_SIGNATURE = 0x06054b50;
const STORED = 0;
const DEFLATED = 8;
// Bit 11 of the flags: the entry name is UTF-8.
const UTF8_NAMES = 0x0800;
const ZIP_VERSION = 20;

export type ZipEntry = {
  readonly name: string;
  readonly data: Uint8Array | string;
  // Deflated unless stored is asked for.
  readonly stored?: boolean;
  // The uncompressed size both headers claim, when it is to differ from the truth.
  readonly claimedSize?: number;
};

const bytesOf = (data: Uint8Array | string): Buffer => (typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data));

export function zipArchive(entries: readonly ZipEntry[]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = bytesOf(entry.data);
    const body = entry.stored === true ? data : deflateRawSync(data);
    const method = entry.stored === true ? STORED : DEFLATED;
    const checksum = crc32(data);
    const size = entry.claimedSize ?? data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_DIRECTORY_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

// ---- Playwright traces ----------------------------------------------------------------------

// The trace format version the repository's pinned Playwright (1.64) writes in its first event.
export const SUPPORTED_TRACE_VERSION = 10;
// A version no Playwright has written.
export const UNKNOWN_TRACE_VERSION = 99;

// The actions of the well-formed trace, in order: what a test did.
export const TRACE_ACTIONS = [
  { class: 'Frame', method: 'goto', title: 'Navigate to "/checkout"', params: { url: 'http://127.0.0.1:4173/checkout' } },
  { class: 'Frame', method: 'click', title: 'Click getByRole(\'button\', { name: \'Pay\' })', params: { selector: 'internal:role=button[name="Pay"i]' } },
] as const;

// A trace file's JSON lines: the context-options event that carries the format version, then a
// before and an after event for each action. `extraLines` are appended as they are.
export function traceLines(version: number = SUPPORTED_TRACE_VERSION, extraLines: readonly string[] = []): string {
  const events: unknown[] = [{
    version, type: 'context-options', origin: 'testRunner', browserName: 'chromium', playwrightVersion: '1.64.1',
    options: {}, platform: 'linux', wallTime: 1_793_000_000_000, monotonicTime: 0, sdkLanguage: 'javascript', testIdAttributeName: 'data-testid',
  }];
  TRACE_ACTIONS.forEach((action, index) => {
    const callId = `call@${index + 1}`;
    events.push({ type: 'before', callId, startTime: 10 * index, title: action.title, class: action.class, method: action.method, params: action.params });
    events.push({ type: 'after', callId, endTime: 10 * index + 5 });
  });
  return [...events.map((event) => JSON.stringify(event)), ...extraLines].join('\n');
}

// The entries of a well-formed trace archive, as Playwright writes one.
export const traceEntries = (version: number = SUPPORTED_TRACE_VERSION): ZipEntry[] => [
  { name: 'trace.trace', data: traceLines(version) },
  { name: 'trace.network', data: '' },
  { name: 'resources/0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c', data: '<!doctype html><title>Checkout</title>' },
];

export const traceArchive = (version: number = SUPPORTED_TRACE_VERSION): Uint8Array => zipArchive(traceEntries(version));
