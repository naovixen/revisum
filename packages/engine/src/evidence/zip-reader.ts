// A zip reader for a suite's trace archives, which arrive as raw bytes from code Revisum does not
// trust. It reads the archive's central directory itself and inflates each entry in memory with
// node:zlib, under an entry count, a total size and a per-entry compression-ratio limit. It never
// trusts a header's sizes, refuses any entry name that could leave the archive, and writes nothing
// to disk. A refusal names an entry by its index, never by its name.
// See docs/specs/SPEC-35-evidence-mode.md.
import { Buffer } from 'node:buffer';
import { crc32, inflateRawSync } from 'node:zlib';
import { failure, success, type Result } from '@revisum/contracts';
import { staysInside } from '../relative-paths.ts';

export type ZipLimits = {
  readonly maximumEntries: number;
  // The archive's own size, and separately the size of all its entries inflated.
  readonly maximumTotalBytes: number;
};
export type ZipEntryData = { readonly name: string; readonly data: Uint8Array };
export type ZipProblem = { readonly code: 'too-large' | 'invalid'; readonly path: string };

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_OF_DIRECTORY_SIGNATURE = 0x06054b50;
const END_OF_DIRECTORY_BYTES = 22;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
const LARGEST_COMMENT_BYTES = 0xffff;
const STORED = 0;
const DEFLATED = 8;
// Bit 0 of the flags: the entry is encrypted.
const ENCRYPTED = 0x0001;
// An entry may inflate to at most this many times its compressed size. Text and HTML compress far
// less than this; a zip bomb compresses far more.
const MAXIMUM_COMPRESSION_RATIO = 200;
// Below this, an entry's size is too small for its ratio to matter.
const RATIO_FREE_BYTES = 64 * 1024;

const invalid = (path: string): Result<never, ZipProblem> => failure({ code: 'invalid', path });
const tooLarge = (path: string): Result<never, ZipProblem> => failure({ code: 'too-large', path });

// Where the end-of-central-directory record starts, searching back over the largest comment.
function endOfDirectory(bytes: Buffer): number | null {
  const earliest = Math.max(0, bytes.length - END_OF_DIRECTORY_BYTES - LARGEST_COMMENT_BYTES);
  for (let offset = bytes.length - END_OF_DIRECTORY_BYTES; offset >= earliest; offset--) {
    if (bytes.readUInt32LE(offset) !== END_OF_DIRECTORY_SIGNATURE) continue;
    // The record's comment must end exactly at the archive's end.
    if (offset + END_OF_DIRECTORY_BYTES + bytes.readUInt16LE(offset + 20) === bytes.length) return offset;
  }
  return null;
}

// An entry name as UTF-8, or null when it is not valid UTF-8.
function entryName(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export function readZip(archive: Uint8Array, limits: ZipLimits): Result<readonly ZipEntryData[], ZipProblem> {
  if (archive.length > limits.maximumTotalBytes) return tooLarge('$');
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  if (bytes.length < END_OF_DIRECTORY_BYTES) return invalid('$');
  const end = endOfDirectory(bytes);
  if (end === null) return invalid('$');
  const entryCount = bytes.readUInt16LE(end + 10);
  const directoryBytes = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  // One disk only, and no zip64 markers: trace archives never need either.
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || bytes.readUInt16LE(end + 8) !== entryCount) return invalid('$');
  if (entryCount === 0xffff || directoryStart === 0xffffffff) return invalid('$');
  if (entryCount > limits.maximumEntries) return tooLarge('$');
  if (directoryStart + directoryBytes > end) return invalid('$');

  const entries: ZipEntryData[] = [];
  const names = new Set<string>();
  let budget = limits.maximumTotalBytes;
  let offset = directoryStart;
  for (let index = 0; index < entryCount; index++) {
    const path = `$.entries[${index}]`;
    if (offset + CENTRAL_HEADER_BYTES > directoryStart + directoryBytes) return invalid(path);
    if (bytes.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE) return invalid(path);
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const checksum = bytes.readUInt32LE(offset + 16);
    const compressedBytes = bytes.readUInt32LE(offset + 20);
    const claimedBytes = bytes.readUInt32LE(offset + 24);
    const nameBytes = bytes.readUInt16LE(offset + 28);
    const extraBytes = bytes.readUInt16LE(offset + 30);
    const commentBytes = bytes.readUInt16LE(offset + 32);
    const localStart = bytes.readUInt32LE(offset + 42);
    const nameStart = offset + CENTRAL_HEADER_BYTES;
    offset = nameStart + nameBytes + extraBytes + commentBytes;
    if (offset > directoryStart + directoryBytes) return invalid(path);
    if ((flags & ENCRYPTED) !== 0 || (method !== STORED && method !== DEFLATED)) return invalid(path);

    const name = entryName(bytes.subarray(nameStart, nameStart + nameBytes));
    if (name === null || !staysInside(name) || names.has(name)) return invalid(path);
    names.add(name);

    // The data lies after the entry's local header and before the directory.
    if (localStart + LOCAL_HEADER_BYTES > directoryStart || bytes.readUInt32LE(localStart) !== LOCAL_HEADER_SIGNATURE) return invalid(path);
    const dataStart = localStart + LOCAL_HEADER_BYTES + bytes.readUInt16LE(localStart + 26) + bytes.readUInt16LE(localStart + 28);
    if (dataStart + compressedBytes > directoryStart) return invalid(path);
    const compressed = bytes.subarray(dataStart, dataStart + compressedBytes);

    // The most this entry may inflate to, whatever its headers claim.
    const allowed = Math.min(budget, Math.max(RATIO_FREE_BYTES, compressedBytes * MAXIMUM_COMPRESSION_RATIO));
    let data: Buffer;
    if (method === STORED) {
      data = compressed;
    } else {
      try {
        data = inflateRawSync(compressed, { 'maxOutputLength': Math.max(allowed, 1) });
      } catch (error) {
        const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
        return code === 'ERR_BUFFER_TOO_LARGE' ? tooLarge(path) : invalid(path);
      }
    }
    if (data.length > allowed) return tooLarge(path);
    if (data.length !== claimedBytes || crc32(data) !== checksum) return invalid(path);
    budget -= data.length;
    entries.push({ name, data: new Uint8Array(data) });
  }
  return success(entries);
}
