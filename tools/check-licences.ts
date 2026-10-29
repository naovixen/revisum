// The licence check. It fails when:
//   - a package's `license` field differs from its entry in licences.json, or a licence text that
//     licences.json names is missing from the repository root;
//   - a package's licence is not one its role allows: schemas, SDKs, drivers and adapters carry
//     Apache-2.0; the engine carries FSL-1.1-ALv2; product packages may carry either;
//   - a published JSON Schema (any *.schema.json in the repository) is not listed as Apache-2.0;
//   - a pinned third-party file, such as axe-core's MPL-2.0 axe.js and axe.min.js, is not the
//     vendor's release byte for byte (the sha256 the vendor publishes in its sri-history.json), or
//     the installed package is not the pinned version, or a copy of it sits under packages/.
// The installed-packages folder is node_modules unless `--modules <folder>` names another.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readWorkspacePackages, reportProblems } from './workspace-packages.ts';

export type PackageRole = 'schema' | 'sdk' | 'driver' | 'adapter' | 'engine' | 'product';

// The licences each role may carry. The engine's licence converts to Apache-2.0 after two years.
export const ROLE_LICENCES: Readonly<Record<PackageRole, readonly string[]>> = {
  schema: ['Apache-2.0'],
  sdk: ['Apache-2.0'],
  driver: ['Apache-2.0'],
  adapter: ['Apache-2.0'],
  engine: ['FSL-1.1-ALv2'],
  product: ['Apache-2.0', 'FSL-1.1-ALv2'],
};
const SCHEMA_LICENCE = 'Apache-2.0';
const SKIPPED_FOLDERS = new Set(['.git', 'node_modules', 'dist', '.browsers', '.idea', '.vscode', '.test-results']);

type PinnedPackage = {
  readonly version: string;
  readonly licence: string;
  // File name inside the package, then its Subresource Integrity hash ("sha256-<base64>").
  readonly files: Readonly<Record<string, string>>;
};

type LicenceMap = {
  readonly licenceFiles: Readonly<Record<string, string>>;
  readonly roles: Readonly<Record<string, string>>;
  readonly packages: Readonly<Record<string, string>>;
  readonly schemas: Readonly<Record<string, string>>;
  readonly pinnedThirdPartyFiles: Readonly<Record<string, PinnedPackage>>;
};

const fieldOf = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;

// A JSON object whose values are all text, or an empty one when the field is missing.
function textRecord(value: unknown, field: string): Readonly<Record<string, string>> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`licences.json: ${field} is not an object`);
  const entries = Object.entries(value);
  for (const [key, text] of entries) if (typeof text !== 'string') throw new Error(`licences.json: ${field}.${key} is not text`);
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export function decodeLicenceMap(input: unknown): LicenceMap {
  const pinned = fieldOf(input, 'pinnedThirdPartyFiles') ?? {};
  if (typeof pinned !== 'object' || pinned === null || Array.isArray(pinned)) throw new Error('licences.json: pinnedThirdPartyFiles is not an object');
  const pinnedThirdPartyFiles: Record<string, PinnedPackage> = {};
  for (const [name, entry] of Object.entries(pinned)) {
    const version = fieldOf(entry, 'version');
    const licence = fieldOf(entry, 'licence');
    if (typeof version !== 'string' || typeof licence !== 'string') throw new Error(`licences.json: pinnedThirdPartyFiles.${name} needs a version and a licence`);
    pinnedThirdPartyFiles[name] = { version, licence, files: textRecord(fieldOf(entry, 'files'), `pinnedThirdPartyFiles.${name}.files`) };
  }
  return {
    licenceFiles: textRecord(fieldOf(input, 'licenceFiles'), 'licenceFiles'),
    roles: textRecord(fieldOf(input, 'roles'), 'roles'),
    packages: textRecord(fieldOf(input, 'packages'), 'packages'),
    schemas: textRecord(fieldOf(input, 'schemas'), 'schemas'),
    pinnedThirdPartyFiles,
  };
}

const isRole = (role: string): role is PackageRole => Object.hasOwn(ROLE_LICENCES, role);

function listFiles(root: string, folder: string): string[] {
  const path = folder === '' ? root : join(root, folder);
  if (!existsSync(path)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (SKIPPED_FOLDERS.has(entry.name)) continue;
    const child = folder === '' ? entry.name : `${folder}/${entry.name}`;
    if (entry.isDirectory()) files.push(...listFiles(root, child));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

const integrityOf = (bytes: Buffer): string => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;

function checkPackageLicences(root: string, licenceMap: LicenceMap): string[] {
  const problems: string[] = [];
  const packages = readWorkspacePackages(root);
  for (const [licence, file] of Object.entries(licenceMap.licenceFiles)) {
    if (!existsSync(join(root, file))) problems.push(`licence text ${file} for ${licence} is missing`);
  }
  for (const workspacePackage of packages) {
    const folder = workspacePackage.folder;
    const expected = licenceMap.packages[folder];
    const actual = workspacePackage.manifest.license;
    if (expected === undefined) {
      problems.push(`packages/${folder} has no entry in licences.json`);
    } else if (!(expected in licenceMap.licenceFiles)) {
      problems.push(`licences.json gives packages/${folder} the licence ${expected}, which has no licence file`);
    } else if (actual !== expected) {
      problems.push(`packages/${folder}/package.json has license ${JSON.stringify(actual)}, licences.json says ${expected}`);
    }
    const role = licenceMap.roles[folder];
    if (role === undefined || !isRole(role)) {
      problems.push(`packages/${folder} has no known role in licences.json (one of ${Object.keys(ROLE_LICENCES).join(', ')})`);
    } else if (expected !== undefined && !ROLE_LICENCES[role].includes(expected)) {
      problems.push(`packages/${folder} is a ${role} package, which must carry ${ROLE_LICENCES[role].join(' or ')}, not ${expected}`);
    }
  }
  for (const folder of new Set([...Object.keys(licenceMap.packages), ...Object.keys(licenceMap.roles)])) {
    if (!packages.some((workspacePackage) => workspacePackage.folder === folder)) {
      problems.push(`licences.json lists ${folder}, which is not a folder under packages/`);
    }
  }
  return problems;
}

function checkSchemas(root: string, licenceMap: LicenceMap): string[] {
  const problems: string[] = [];
  for (const file of listFiles(root, '').filter((path) => path.endsWith('.schema.json'))) {
    const licence = licenceMap.schemas[file];
    if (licence === undefined) problems.push(`${file} is a published JSON Schema that licences.json does not list; schemas carry ${SCHEMA_LICENCE}`);
    else if (licence !== SCHEMA_LICENCE) problems.push(`${file} is a JSON Schema, which must carry ${SCHEMA_LICENCE}, not ${licence}`);
  }
  for (const file of Object.keys(licenceMap.schemas)) {
    if (!existsSync(join(root, file))) problems.push(`licences.json lists the schema ${file}, which does not exist`);
  }
  return problems;
}

function checkPinnedFiles(root: string, modules: string, licenceMap: LicenceMap): string[] {
  const problems: string[] = [];
  const pinnedIntegrities = new Map<string, string>();
  for (const [name, pinned] of Object.entries(licenceMap.pinnedThirdPartyFiles)) {
    const folder = join(modules, name);
    const manifestPath = join(folder, 'package.json');
    const installed = existsSync(manifestPath) ? fieldOf(JSON.parse(readFileSync(manifestPath, 'utf8')), 'version') : undefined;
    if (installed !== pinned.version) {
      problems.push(`${name} ${String(installed ?? 'is not installed')}${installed === undefined ? '' : ' is installed'}; licences.json pins ${pinned.version}`);
    }
    for (const [file, integrity] of Object.entries(pinned.files)) {
      pinnedIntegrities.set(integrity, `${name}/${file}`);
      const path = join(folder, file);
      if (!existsSync(path)) {
        problems.push(`${name}/${file} (${pinned.licence}) is not installed`);
      } else if (integrityOf(readFileSync(path)) !== integrity) {
        problems.push(`${name}/${file} (${pinned.licence}) differs from the pinned ${pinned.version} release; never edit it, only pin a new release`);
      }
    }
  }
  // A copy under packages/ would be an edit waiting to happen and a second file to keep licensed.
  for (const file of listFiles(root, 'packages')) {
    const name = file.split('/').at(-1) ?? file;
    const copied = /^axe.*\.js$/.test(name) ? name : pinnedIntegrities.get(integrityOf(readFileSync(join(root, file))));
    if (copied !== undefined) problems.push(`${file} is a copy of ${copied}; read the pinned file from the installed package instead`);
  }
  return problems;
}

export function checkLicences(root: string, modules = join(root, 'node_modules')): string[] {
  let licenceMap: LicenceMap;
  try {
    licenceMap = decodeLicenceMap(JSON.parse(readFileSync(join(root, 'licences.json'), 'utf8')));
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return [...checkPackageLicences(root, licenceMap), ...checkSchemas(root, licenceMap), ...checkPinnedFiles(root, modules, licenceMap)];
}

if (import.meta.main) {
  const words = process.argv.slice(2);
  const flag = words.indexOf('--modules');
  const modules = flag === -1 ? undefined : words[flag + 1];
  const root = process.cwd();
  process.exitCode = reportProblems('licence check', checkLicences(root, modules === undefined ? undefined : resolve(root, modules)));
}
