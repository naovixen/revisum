// parseSuiteTrace reads a Playwright trace archive, which arrives as raw bytes from the suite's
// output directory, with its own zip reader on node:zlib: it reads the central directory itself,
// inflates each entry in memory under the entry count, total size and compression-ratio limits,
// and writes nothing to disk. A zip bomb is too-large; an entry name that leaves the archive, or a
// truncated archive, is trace-invalid; a trace format version it does not know is
// trace-unsupported. A refusal never echoes an entry's name or content.
// Counter-examples: the same archives, made well-formed or within the limits, are read.
// See docs/specs/SPEC-35-evidence-mode.md.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { test } from 'node:test';
import { parseSuiteTrace, type EvidenceLimits, type SuiteDecodeError } from '@revisum/engine';
import { evidenceLimits } from './evidence-examples.ts';
import {
  SUPPORTED_TRACE_VERSION, TRACE_ACTIONS, UNKNOWN_TRACE_VERSION, traceArchive, traceEntries, zipArchive, type ZipEntry,
} from './zip-archives.ts';

const MEBIBYTE = 1024 * 1024;

function accepted(archive: Uint8Array, limits: EvidenceLimits = evidenceLimits()) {
  const decoded = parseSuiteTrace(archive, limits);
  assert.ok(decoded.ok, `the trace was refused: ${JSON.stringify(decoded)}`);
  return decoded.value;
}

function refusal(archive: Uint8Array, limits: EvidenceLimits = evidenceLimits()): SuiteDecodeError {
  const decoded = parseSuiteTrace(archive, limits);
  assert.equal(decoded.ok, false, 'the trace was accepted');
  return decoded.ok ? { code: 'trace-invalid', path: '' } : decoded.error;
}

// ---- A well-formed trace, the counter-example to every refusal below -----------------------------

test('a well-formed trace archive is read, and holds its two actions in order', { criterion: 'AC-SPEC-35-10' }, () => {
  const trace = accepted(traceArchive());
  assert.equal(trace.actions.length, TRACE_ACTIONS.length, JSON.stringify(trace.actions));
});

// ---- Zip bombs --------------------------------------------------------------------------------------

test('an archive whose entries inflate past maximumTraceBytes is refused as too-large', { criterion: 'AC-SPEC-35-10' }, () => {
  // Random bytes do not compress, so only the total size, not the ratio, is over a limit here.
  const archive = zipArchive([...traceEntries(), { name: 'resources/large-image', data: randomBytes(2 * MEBIBYTE) }]);
  assert.equal(refusal(archive, evidenceLimits({ maximumTraceBytes: MEBIBYTE })).code, 'too-large');
  accepted(archive, evidenceLimits({ maximumTraceBytes: 4 * MEBIBYTE }));
});

test('an entry that inflates a thousandfold, a zip bomb, is refused as too-large even under the size limit', { criterion: 'AC-SPEC-35-10' }, () => {
  // Four MiB of zeros deflate to about four KiB: far over any compression-ratio limit, and far
  // under the default 100 MiB per trace.
  const archive = zipArchive([...traceEntries(), { name: 'resources/zeros', data: new Uint8Array(4 * MEBIBYTE) }]);
  assert.equal(refusal(archive).code, 'too-large');
});

test('an entry whose headers claim a small size but which inflates past the limit is refused, not trusted', { criterion: 'AC-SPEC-35-10' }, () => {
  const archive = zipArchive([
    ...traceEntries(), { name: 'resources/lying-entry', data: randomBytes(2 * MEBIBYTE), claimedSize: 100 },
  ]);
  assert.ok(['too-large', 'trace-invalid'].includes(refusal(archive, evidenceLimits({ maximumTraceBytes: MEBIBYTE })).code));
});

// ---- Entry names that leave the archive --------------------------------------------------------------

const marker = (): string => `escaped-${randomBytes(6).toString('hex')}`;

const ESCAPING_NAMES: readonly { readonly title: string; readonly name: (file: string) => string }[] = [
  { title: 'a parent-folder entry', name: (file) => `../${file}.txt` },
  { title: 'an entry that climbs out through a subfolder', name: (file) => `resources/../../${file}.txt` },
  { title: 'an entry of a bare ".."', name: () => '..' },
  { title: 'a parent-folder entry written with backslashes', name: (file) => `..\\..\\${file}.txt` },
  { title: 'an absolute POSIX path', name: (file) => `/tmp/${file}.txt` },
  { title: 'an absolute Windows path with a drive letter', name: (file) => `C:/${file}.txt` },
  { title: 'an absolute Windows path with backslashes', name: (file) => `C:\\${file}.txt` },
  { title: 'a Windows network path', name: (file) => `\\\\server\\share\\${file}.txt` },
];

for (const { title, name } of ESCAPING_NAMES) {
  test(`${title} is refused as trace-invalid, the name is not echoed, and nothing is written`, { criterion: 'AC-SPEC-35-10' }, () => {
    const file = marker();
    const entryName = name(file);
    const error = refusal(zipArchive([...traceEntries(), { name: entryName, data: 'written outside the archive' }]));
    assert.equal(error.code, 'trace-invalid');
    assert.ok(!JSON.stringify(error).includes(file), `the refusal echoes the entry name: ${JSON.stringify(error)}`);
    const unixName = entryName.replaceAll('\\', '/');
    for (const target of [resolve(unixName), resolve(tmpdir(), unixName), ...(isAbsolute(unixName) ? [unixName] : [])]) {
      assert.equal(existsSync(target), false, `a file was written at ${target}`);
    }
  });
}

test('counter-example: an entry inside a subfolder of the archive is read', { criterion: 'AC-SPEC-35-10' }, () => {
  accepted(zipArchive([...traceEntries(), { name: `resources/${marker()}.txt`, data: 'inside the archive' }]));
});

// ---- Too many entries --------------------------------------------------------------------------------

const withResources = (count: number): ZipEntry[] => [
  ...traceEntries().slice(0, 2),
  ...Array.from({ length: count }, (_, index): ZipEntry => ({ name: `resources/resource-${index}`, data: `resource ${index}` })),
];

test('an archive with more entries than maximumTraceEntries is refused as too-large', { criterion: 'AC-SPEC-35-10' }, () => {
  assert.equal(refusal(zipArchive(withResources(4)), evidenceLimits({ maximumTraceEntries: 5 })).code, 'too-large');
});

test('counter-example: an archive with exactly maximumTraceEntries entries is read', { criterion: 'AC-SPEC-35-10' }, () => {
  accepted(zipArchive(withResources(3)), evidenceLimits({ maximumTraceEntries: 5 }));
});

// ---- Truncated and malformed archives -----------------------------------------------------------------

test('an archive cut short before its end record is refused as trace-invalid', { criterion: 'AC-SPEC-35-10' }, () => {
  const archive = traceArchive();
  assert.equal(refusal(archive.slice(0, archive.length - 10)).code, 'trace-invalid');
});

test('an archive cut in half, inside its entries, is refused as trace-invalid', { criterion: 'AC-SPEC-35-10' }, () => {
  const archive = traceArchive();
  assert.equal(refusal(archive.slice(0, Math.floor(archive.length / 2))).code, 'trace-invalid');
});

test('an archive whose directory points past its own end is refused as trace-invalid', { criterion: 'AC-SPEC-35-10' }, () => {
  const archive = Buffer.from(traceArchive());
  // The end record's last four-byte field before the comment length is the directory's offset.
  archive.writeUInt32LE(archive.length + 4096, archive.length - 6);
  assert.equal(refusal(new Uint8Array(archive)).code, 'trace-invalid');
});

test('an empty file and random bytes are each refused as trace-invalid', { criterion: 'AC-SPEC-35-10' }, () => {
  assert.equal(refusal(new Uint8Array(0)).code, 'trace-invalid');
  assert.equal(refusal(new Uint8Array(randomBytes(4096))).code, 'trace-invalid');
});

// ---- Trace versions ------------------------------------------------------------------------------------

test('a trace of a version no Playwright has written is refused as trace-unsupported, never guessed at', { criterion: 'AC-SPEC-35-10' }, () => {
  assert.equal(refusal(traceArchive(UNKNOWN_TRACE_VERSION)).code, 'trace-unsupported');
  accepted(traceArchive(SUPPORTED_TRACE_VERSION));
});
