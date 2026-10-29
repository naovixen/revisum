// The target lock: each target in the matrix pinned to the exact browser build its adapter runs,
// by version and the sha256 of the executable. `lock` works out the entries, `lockToFile` keeps
// them in targets.lock.json beside project.json, and `checkPinnedBuild` refuses a run whose build
// is not the pinned one. A build is never upgraded or swapped silently.
// See docs/specs/SPEC-05-target-matrix-and-lock.md.
import {
  failure, success,
  type AdapterRegistry, type BrowserDriver, type BuildFailureCode, type LockEntry, type LockFailure, type LockfileFailure, type Result,
  type Target, type TargetId, type Unavailable, type UnavailableReason,
} from '@revisum/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalJson } from '../hashing.ts';
import { INVALID, allValid, readList, readRecord, type Issues, type Parsed, type PlanError } from '../plan/plan-decoders.ts';
import { readBuildVersion, readId } from '../project/project-parser.ts';
import type { TrustedProject } from '../project/trusted-project.ts';
import { schemaId } from '../version.ts';

export const LOCKFILE_NAME = 'targets.lock.json';
export const LOCKFILE_SCHEMA = schemaId('targets-lock', 1);
// What a run's manifest lists under nonHermeticInputs when a lockfile is in use but the target's
// browser build could not be pinned.
export const BROWSER_BUILD_INPUT = 'browser-build';

const SHA256_HEX = /^[0-9a-f]{64}$/;
// The matrix holds at most 64 targets, so a lockfile never needs more entries.
const MAXIMUM_LOCK_ENTRIES = 64;
const ENTRY_KEYS = ['targetId', 'version', 'executableSha256'] as const;

const compareText = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);
const byTargetId = (left: LockEntry, right: LockEntry): number => compareText(left.targetId, right.targetId);

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The sha256 of a file, read as a stream: a browser executable can be hundreds of megabytes.
export async function hashExecutable(path: string): Promise<Result<string, string>> {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return success(hash.digest('hex'));
  } catch (error) {
    return failure(`cannot read the browser executable at ${path}: ${errorText(error)}`);
  }
}

function readLockEntry(input: unknown, path: string, issues: Issues): Parsed<LockEntry> {
  const fields = readRecord(input, path, issues, ENTRY_KEYS);
  if (fields === INVALID) return INVALID;
  const parts = [
    readId<'TargetId'>(fields['targetId'], `${path}.targetId`, issues),
    readBuildVersion(fields['version'], `${path}.version`, issues),
  ] as const;
  const executableSha256 = fields['executableSha256'];
  const hashValid = typeof executableSha256 === 'string' && SHA256_HEX.test(executableSha256);
  if (!hashValid) {
    issues.push({ code: typeof executableSha256 === 'string' ? 'unknown_value' : 'wrong_type', path: `${path}.executableSha256` });
  }
  if (!allValid(parts) || !hashValid) return INVALID;
  const [targetId, version] = parts;
  return { targetId, version, executableSha256 };
}

// The lockfile's content, parsed by hand: unknown keys, another schema, a malformed hash or a
// target pinned twice are all rejected, each at its JSON path.
export function parseLockfile(input: unknown): Result<readonly LockEntry[], readonly PlanError[]> {
  const issues: Issues = [];
  const fields = readRecord(input, '$', issues, ['schema', 'entries']);
  if (fields === INVALID) return failure(issues);
  if (fields['schema'] !== LOCKFILE_SCHEMA) issues.push({ code: 'version_unsupported', path: '$.schema' });
  const raw = readList(fields['entries'], '$.entries', issues, MAXIMUM_LOCK_ENTRIES, 0);
  if (raw === INVALID) return failure(issues);
  const entries = raw.map((entry, index) => readLockEntry(entry, `$.entries[${index}]`, issues));
  const seen = new Set<TargetId>();
  entries.forEach((entry, index) => {
    if (entry === INVALID) return;
    if (seen.has(entry.targetId)) issues.push({ code: 'duplicate', path: `$.entries[${index}].targetId` });
    seen.add(entry.targetId);
  });
  if (issues.length > 0 || !allValid(entries)) return failure(issues);
  return success([...entries].sort(byTargetId));
}

// The file's exact text: canonical JSON, entries sorted by target id, and a final newline, so the
// same entries always give the same bytes.
export const lockfileText = (entries: readonly LockEntry[]): string =>
  `${canonicalJson({ schema: LOCKFILE_SCHEMA, entries: [...entries].sort(byTargetId) })}\n`;

// The entries of the lockfile in `folder`; none when there is no lockfile yet.
export async function readLockfile(folder: string): Promise<Result<readonly LockEntry[], LockfileFailure>> {
  let text: string;
  try {
    text = await readFile(join(folder, LOCKFILE_NAME), 'utf8');
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, 'code') === 'ENOENT') return success([]);
    return failure({ targetId: null, code: 'lockfile-invalid', detail: `cannot read ${LOCKFILE_NAME}: ${errorText(error)}` });
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return failure({ targetId: null, code: 'lockfile-invalid', detail: `${LOCKFILE_NAME} is not JSON` });
  }
  const parsed = parseLockfile(input);
  if (parsed.ok) return parsed;
  const where = parsed.error.map((error) => `${error.code} at ${error.path}`).join(', ');
  return failure({ targetId: null, code: 'lockfile-invalid', detail: `${LOCKFILE_NAME} does not parse: ${where}` });
}

// Pins every target in the matrix, in target id order. The first target that cannot be pinned
// fails the whole lock and is named, so nothing is half-locked. `previous` holds the entries
// already pinned: the same version with a different executable is refused as build-mismatch,
// since a build that changes under the same version number is not the build that was tested.
export async function lock(
  project: TrustedProject, registry: AdapterRegistry, previous: readonly LockEntry[],
): Promise<Result<readonly LockEntry[], LockFailure>> {
  const entries: LockEntry[] = [];
  for (const target of [...project.matrix].sort((left, right) => compareText(left.id, right.id))) {
    const driver = registry.find(target.adapter);
    if (driver === null) {
      return failure({ targetId: target.id, code: 'adapter-not-registered', detail: `no adapter '${target.adapter}' is registered` });
    }
    const supported = driver.supports(target);
    if (!supported.ok) return failure({ targetId: target.id, code: supported.error.reason, detail: supported.error.detail });
    // An adapter that cannot report its build cannot be pinned; its runs record the browser build
    // as a non-hermetic input instead.
    if (driver.build === undefined) continue;
    const built = await driver.build(target);
    if (!built.ok) return failure({ targetId: target.id, code: built.error.code, detail: built.error.detail });
    // The version goes into the lockfile, so it must pass the lockfile's own decoder.
    const version = readBuildVersion(built.value.version, '$.version', []);
    if (version === INVALID) {
      return failure({ targetId: target.id, code: 'lock-download-failed', detail: 'the adapter reported a build with no usable version number' });
    }
    const hashed = await hashExecutable(built.value.executablePath);
    if (!hashed.ok) return failure({ targetId: target.id, code: 'lock-download-failed', detail: hashed.error });
    const pinned = previous.find((entry) => entry.targetId === target.id);
    if (pinned !== undefined && pinned.version === version && pinned.executableSha256 !== hashed.value) {
      return failure({
        targetId: target.id, code: 'build-mismatch',
        detail: `version ${version} was pinned with sha256 ${pinned.executableSha256}, but its executable now hashes to ${hashed.value}`,
      });
    }
    entries.push({ targetId: target.id, version, executableSha256: hashed.value });
  }
  return success(entries);
}

// Locks the matrix and writes targets.lock.json in `folder`, only when every target locked. The
// new file is written beside the old one and then renamed over it, so a failure at any point
// leaves the existing lockfile byte for byte as it was.
export async function lockToFile(
  folder: string, project: TrustedProject, registry: AdapterRegistry,
): Promise<Result<readonly LockEntry[], LockFailure>> {
  const previous = await readLockfile(folder);
  if (!previous.ok) return previous;
  const locked = await lock(project, registry, previous.value);
  if (!locked.ok) return locked;
  const temporary = join(folder, `.${LOCKFILE_NAME}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, lockfileText(locked.value), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, join(folder, LOCKFILE_NAME));
  } catch (error) {
    await rm(temporary, { force: true });
    return failure({ targetId: null, code: 'lockfile-unwritable', detail: `cannot write ${LOCKFILE_NAME}: ${errorText(error)}` });
  }
  return locked;
}

// The lock-time codes have no run-time meaning of their own: at run time the build is simply not
// there to launch.
const runTimeReason = (code: BuildFailureCode): UnavailableReason =>
  (code === 'lock-download-failed' || code === 'lock-offline' ? 'launch-failed' : code);

// Before a run opens a browser: when the lockfile pins the target, the adapter's build must have
// the pinned version and executable hash, or the target is unavailable with build-mismatch.
// 'unpinned' means the run goes ahead on a build nothing pinned: the lockfile has no entry for the
// target, or the adapter cannot report its build.
export async function checkPinnedBuild(
  driver: BrowserDriver, target: Target, entries: readonly LockEntry[],
): Promise<Result<'pinned' | 'unpinned', Unavailable>> {
  const pinned = entries.find((entry) => entry.targetId === target.id);
  if (pinned === undefined || driver.build === undefined) return success('unpinned');
  const built = await driver.build(target);
  if (!built.ok) return failure({ reason: runTimeReason(built.error.code), detail: built.error.detail });
  const hashed = await hashExecutable(built.value.executablePath);
  if (!hashed.ok) return failure({ reason: 'launch-failed', detail: hashed.error });
  if (built.value.version !== pinned.version || hashed.value !== pinned.executableSha256) {
    return failure({
      reason: 'build-mismatch',
      detail: `the lockfile pins version ${pinned.version} with sha256 ${pinned.executableSha256}; `
        + `this machine has version ${built.value.version} with sha256 ${hashed.value}`,
    });
  }
  return success('pinned');
}
