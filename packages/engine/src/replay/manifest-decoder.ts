// Reads a run manifest back from JSON, such as one a replay is handed, field by field. A manifest
// of another schema version, or with a key this version does not know, is refused as
// version-unsupported: a newer engine may have recorded an input this one would silently ignore.
// A known field of the wrong shape is a replay-mismatch at its JSON path. Nothing is guessed.
import {
  DRIVER_FEATURES, UNSAFE_FEATURES, failure, success,
  type AdapterInfo, type Result,
} from '@revisum/contracts';
import type {
  EvidenceManifestRecord, FixtureReference, HostInfo, RunManifest, RunVersions, SecretRecord, StorageStateRecord, UnsafeDeclarationRecord,
} from '../manifest.ts';
import { INVALID, allValid, readInteger, readList, readOneOf, readRecord, type Issues, type Parsed } from '../plan/plan-decoders.ts';
import { readImageDigest, readSuiteName } from '../project/evidence-declarations.ts';
import { readSecretName, readTarget } from '../project/project-parser.ts';
import { schemaId } from '../version.ts';

export const MANIFEST_SCHEMA = schemaId('run-manifest', 1);

// Why a manifest or recording could not be read: of a version, or with a key, this engine does not
// read; or a known field of the wrong shape, at its JSON path.
export type DecodeError =
  | { readonly code: 'version-unsupported'; readonly path: string }
  | { readonly code: 'replay-mismatch'; readonly path: string };

const REQUIRED_KEYS = ['schema', 'engineVersion', 'planHash', 'seeds', 'clock', 'fixtures', 'host', 'nonHermeticInputs'] as const;
const OPTIONAL_KEYS = [
  'target', 'adapter', 'browser', 'secrets', 'storageState', 'unsafeFeatures', 'unsafeDeclarations', 'responseRewrites', 'evidence',
  'executableSha256', 'projectHash', 'versions', 'redactor', 'limits', 'baselinesHash', 'rulesetHash', 'imageDigest', 'fontsSha256', 'commit',
] as const;

const SHA256_HEX = /^[0-9a-f]{64}$/;
// Generous bounds that a real manifest never reaches, so a hostile one cannot exhaust memory.
const MAXIMUM_TEXT_LENGTH = 4096;
const MAXIMUM_LIST_LENGTH = 100_000;

export const isPlainRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

// Issues as a decode error: an unknown key anywhere means another version; otherwise the first
// field of the wrong shape.
export function decodeErrorOf(issues: Issues): DecodeError {
  const unknown = issues.find((issue) => issue.code === 'unknown_field');
  if (unknown !== undefined) return { code: 'version-unsupported', path: unknown.path };
  return { code: 'replay-mismatch', path: issues[0]?.path ?? '$' };
}

export function readString(input: unknown, path: string, issues: Issues, maximumLength = MAXIMUM_TEXT_LENGTH): Parsed<string> {
  if (typeof input !== 'string' || input.length > maximumLength) { issues.push({ code: 'wrong_type', path }); return INVALID; }
  return input;
}

export function readSha256(input: unknown, path: string, issues: Issues): Parsed<string> {
  if (typeof input !== 'string' || !SHA256_HEX.test(input)) { issues.push({ code: 'wrong_type', path }); return INVALID; }
  return input;
}

function readStrings(input: unknown, path: string, issues: Issues): Parsed<readonly string[]> {
  const raw = readList(input, path, issues, MAXIMUM_LIST_LENGTH, 0);
  if (raw === INVALID) return INVALID;
  const values = raw.map((value, index) => readString(value, `${path}[${index}]`, issues));
  return allValid(values) ? values : INVALID;
}

// Each entry of a list, read by `read`.
function readEach<Value>(
  input: unknown, path: string, issues: Issues, read: (entry: unknown, path: string, issues: Issues) => Parsed<Value>,
): Parsed<readonly Value[]> {
  const raw = readList(input, path, issues, MAXIMUM_LIST_LENGTH, 0);
  if (raw === INVALID) return INVALID;
  const values = raw.map((entry, index) => read(entry, `${path}[${index}]`, issues));
  return allValid(values) ? values : INVALID;
}

const readSafeInteger = (input: unknown, path: string, issues: Issues): Parsed<number> =>
  readInteger(input, path, issues, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);

function readAdapter(input: unknown, path: string, issues: Issues): Parsed<AdapterInfo> {
  const fields = readRecord(input, path, issues, ['id', 'version', 'protocol', 'cannotPin', 'performs'], ['id', 'version', 'protocol']);
  if (fields === INVALID) return INVALID;
  const parts = [
    readString(fields['id'], `${path}.id`, issues),
    readString(fields['version'], `${path}.version`, issues),
    readString(fields['protocol'], `${path}.protocol`, issues),
  ] as const;
  const cannotPin = fields['cannotPin'] === undefined ? undefined : readStrings(fields['cannotPin'], `${path}.cannotPin`, issues);
  const performs = fields['performs'] === undefined ? undefined
    : readEach(fields['performs'], `${path}.performs`, issues, (entry, at, found) => readOneOf(entry, at, found, DRIVER_FEATURES));
  if (!allValid(parts) || cannotPin === INVALID || performs === INVALID) return INVALID;
  const [id, version, protocol] = parts;
  return { id, version, protocol, ...(cannotPin === undefined ? {} : { cannotPin }), ...(performs === undefined ? {} : { performs }) };
}

function readNamedVersion(input: unknown, path: string, issues: Issues): Parsed<{ readonly name: string; readonly version: string }> {
  const fields = readRecord(input, path, issues, ['name', 'version']);
  if (fields === INVALID) return INVALID;
  const name = readString(fields['name'], `${path}.name`, issues);
  const version = readString(fields['version'], `${path}.version`, issues);
  return name === INVALID || version === INVALID ? INVALID : { name, version };
}

function readFixture(input: unknown, path: string, issues: Issues): Parsed<FixtureReference> {
  const fields = readRecord(input, path, issues, ['path', 'sha256']);
  if (fields === INVALID) return INVALID;
  const fixturePath = readString(fields['path'], `${path}.path`, issues);
  const hash = readSha256(fields['sha256'], `${path}.sha256`, issues);
  return fixturePath === INVALID || hash === INVALID ? INVALID : { path: fixturePath, sha256: hash };
}

function readHost(input: unknown, path: string, issues: Issues): Parsed<HostInfo> {
  const fields = readRecord(input, path, issues, ['platform', 'arch']);
  if (fields === INVALID) return INVALID;
  const platform = readString(fields['platform'], `${path}.platform`, issues);
  const arch = readString(fields['arch'], `${path}.arch`, issues);
  return platform === INVALID || arch === INVALID ? INVALID : { platform, arch };
}

function readSecretRecord(input: unknown, path: string, issues: Issues): Parsed<SecretRecord> {
  const fields = readRecord(input, path, issues, ['name', 'mode']);
  if (fields === INVALID) return INVALID;
  const name = readSecretName(fields['name'], `${path}.name`, issues);
  const mode = readOneOf(fields['mode'], `${path}.mode`, issues, ['value', 'key-only'] as const);
  return name === INVALID || mode === INVALID ? INVALID : { name, mode };
}

function readStorageState(input: unknown, path: string, issues: Issues): Parsed<StorageStateRecord> {
  const fields = readRecord(input, path, issues, ['name', 'sha256']);
  if (fields === INVALID) return INVALID;
  const name = readSecretName(fields['name'], `${path}.name`, issues);
  const hash = readSha256(fields['sha256'], `${path}.sha256`, issues);
  return name === INVALID || hash === INVALID ? INVALID : { name, sha256: hash };
}

function readUnsafeDeclaration(input: unknown, path: string, issues: Issues): Parsed<UnsafeDeclarationRecord> {
  const fields = readRecord(input, path, issues, ['kind', 'name', 'sha256']);
  if (fields === INVALID) return INVALID;
  const kind = readOneOf(fields['kind'], `${path}.kind`, issues, ['script', 'command'] as const);
  const name = readString(fields['name'], `${path}.name`, issues);
  const hash = readSha256(fields['sha256'], `${path}.sha256`, issues);
  return kind === INVALID || name === INVALID || hash === INVALID ? INVALID : { kind, name, sha256: hash };
}

function readRewrite(input: unknown, path: string, issues: Issues): Parsed<{ readonly origin: string; readonly name: string }> {
  const fields = readRecord(input, path, issues, ['origin', 'name']);
  if (fields === INVALID) return INVALID;
  const origin = readString(fields['origin'], `${path}.origin`, issues);
  const name = readString(fields['name'], `${path}.name`, issues);
  return origin === INVALID || name === INVALID ? INVALID : { origin, name };
}

function readEvidence(input: unknown, path: string, issues: Issues): Parsed<EvidenceManifestRecord> {
  const fields = readRecord(input, path, issues, ['suite', 'suiteFiles', 'commandSha256', 'image', 'selfReported']);
  if (fields === INVALID) return INVALID;
  const suite = readSuiteName(fields['suite'], `${path}.suite`, issues);
  const files = readRecord(fields['suiteFiles'], `${path}.suiteFiles`, issues, ['count', 'sha256']);
  const count = files === INVALID ? INVALID : readInteger(files['count'], `${path}.suiteFiles.count`, issues, 0, Number.MAX_SAFE_INTEGER);
  const filesHash = files === INVALID ? INVALID : readSha256(files['sha256'], `${path}.suiteFiles.sha256`, issues);
  const commandSha256 = readSha256(fields['commandSha256'], `${path}.commandSha256`, issues);
  const image = readImageDigest(fields['image'], `${path}.image`, issues);
  const reported = readRecord(fields['selfReported'], `${path}.selfReported`, issues, ['playwrightVersion', 'browsers']);
  const playwrightVersion = reported === INVALID ? INVALID
    : reported['playwrightVersion'] === null ? null : readString(reported['playwrightVersion'], `${path}.selfReported.playwrightVersion`, issues);
  const browsers = reported === INVALID ? INVALID : readStrings(reported['browsers'], `${path}.selfReported.browsers`, issues);
  if (suite === INVALID || count === INVALID || filesHash === INVALID || commandSha256 === INVALID || image === INVALID
    || playwrightVersion === INVALID || browsers === INVALID) return INVALID;
  return { suite, suiteFiles: { count, sha256: filesHash }, commandSha256, image, selfReported: { playwrightVersion, browsers } };
}

function readVersions(input: unknown, path: string, issues: Issues): Parsed<RunVersions> {
  const fields = readRecord(input, path, issues, ['core', 'act', 'axe', 'node', 'packs']);
  if (fields === INVALID) return INVALID;
  const parts = [
    readString(fields['core'], `${path}.core`, issues),
    readString(fields['act'], `${path}.act`, issues),
    readString(fields['axe'], `${path}.axe`, issues),
    readString(fields['node'], `${path}.node`, issues),
  ] as const;
  const packs = readStrings(fields['packs'], `${path}.packs`, issues);
  if (!allValid(parts) || packs === INVALID) return INVALID;
  const [core, act, axe, node] = parts;
  return { core, act, axe, node, packs };
}

function readCommit(input: unknown, path: string, issues: Issues): Parsed<string | null> {
  return input === null ? null : readString(input, path, issues);
}

// One optional field: absent stays absent, so the manifest read back is the manifest written.
function optional<Value>(
  fields: Readonly<Record<string, unknown>>, key: (typeof OPTIONAL_KEYS)[number], issues: Issues,
  read: (input: unknown, path: string, issues: Issues) => Parsed<Value>,
): Parsed<Value | undefined> {
  return Object.hasOwn(fields, key) ? read(fields[key], `$.${key}`, issues) : undefined;
}

export function decodeManifest(input: unknown): Result<RunManifest, DecodeError> {
  if (!isPlainRecord(input)) return failure({ code: 'version-unsupported', path: '$' });
  // The schema first: a manifest of another version is refused whole, before any field is read.
  if (input['schema'] !== MANIFEST_SCHEMA) return failure({ code: 'version-unsupported', path: '$.schema' });
  const issues: Issues = [];
  const fields = readRecord(input, '$', issues, [...REQUIRED_KEYS, ...OPTIONAL_KEYS], REQUIRED_KEYS);
  if (fields === INVALID) return failure(decodeErrorOf(issues));
  const seeds = readRecord(fields['seeds'], '$.seeds', issues, ['random']);
  const clock = readRecord(fields['clock'], '$.clock', issues, ['fixedTimeMilliseconds']);
  const required = [
    readString(fields['engineVersion'], '$.engineVersion', issues),
    readSha256(fields['planHash'], '$.planHash', issues),
    seeds === INVALID ? INVALID : readSafeInteger(seeds['random'], '$.seeds.random', issues),
    clock === INVALID ? INVALID : readSafeInteger(clock['fixedTimeMilliseconds'], '$.clock.fixedTimeMilliseconds', issues),
    readEach(fields['fixtures'], '$.fixtures', issues, readFixture),
    readHost(fields['host'], '$.host', issues),
    readStrings(fields['nonHermeticInputs'], '$.nonHermeticInputs', issues),
  ] as const;
  const extras = [
    optional(fields, 'target', issues, readTarget),
    optional(fields, 'adapter', issues, readAdapter),
    optional(fields, 'browser', issues, readNamedVersion),
    optional(fields, 'secrets', issues, (value, at, found) => readEach(value, at, found, readSecretRecord)),
    optional(fields, 'storageState', issues, readStorageState),
    optional(fields, 'unsafeFeatures', issues, (value, at, found) => readEach(value, at, found, (entry, path, list) => readOneOf(entry, path, list, UNSAFE_FEATURES))),
    optional(fields, 'unsafeDeclarations', issues, (value, at, found) => readEach(value, at, found, readUnsafeDeclaration)),
    optional(fields, 'responseRewrites', issues, (value, at, found) => readEach(value, at, found, readRewrite)),
    optional(fields, 'evidence', issues, readEvidence),
  ] as const;
  const pinned = [
    optional(fields, 'executableSha256', issues, readSha256),
    optional(fields, 'projectHash', issues, readSha256),
    optional(fields, 'versions', issues, readVersions),
    optional(fields, 'redactor', issues, readSha256),
    optional(fields, 'limits', issues, readSha256),
    optional(fields, 'baselinesHash', issues, readSha256),
    optional(fields, 'rulesetHash', issues, readSha256),
    optional(fields, 'imageDigest', issues, readString),
    optional(fields, 'fontsSha256', issues, readSha256),
    optional(fields, 'commit', issues, readCommit),
  ] as const;
  if (!allValid(required) || !allValid(extras) || !allValid(pinned)) return failure(decodeErrorOf(issues));
  const [engineVersion, planHash, random, fixedTimeMilliseconds, fixtures, host, nonHermeticInputs] = required;
  const [target, adapter, browser, secrets, storageState, unsafeFeatures, unsafeDeclarations, responseRewrites, evidence] = extras;
  const [executableSha256, projectHash, versions, redactor, limits, baselinesHash, rulesetHash, imageDigest, fontsSha256, commit] = pinned;
  return success({
    schema: MANIFEST_SCHEMA, engineVersion, planHash, seeds: { random }, clock: { fixedTimeMilliseconds }, fixtures, host, nonHermeticInputs,
    ...(target === undefined ? {} : { target }), ...(adapter === undefined ? {} : { adapter }), ...(browser === undefined ? {} : { browser }), ...(secrets === undefined ? {} : { secrets }),
    ...(storageState === undefined ? {} : { storageState }), ...(unsafeFeatures === undefined ? {} : { unsafeFeatures }), ...(unsafeDeclarations === undefined ? {} : { unsafeDeclarations }),
    ...(responseRewrites === undefined ? {} : { responseRewrites }), ...(evidence === undefined ? {} : { evidence }),
    ...(executableSha256 === undefined ? {} : { executableSha256 }), ...(projectHash === undefined ? {} : { projectHash }), ...(versions === undefined ? {} : { versions }),
    ...(redactor === undefined ? {} : { redactor }), ...(limits === undefined ? {} : { limits }), ...(baselinesHash === undefined ? {} : { baselinesHash }),
    ...(rulesetHash === undefined ? {} : { rulesetHash }), ...(imageDigest === undefined ? {} : { imageDigest }), ...(fontsSha256 === undefined ? {} : { fontsSha256 }),
    ...(commit === undefined ? {} : { commit }),
  });
}
