// Declared calls add no new trust route and no dependency:
//   - contracts, engine and runner declare no runtime dependency, contracts and engine import no
//     protocol pack, and runner imports nothing but contracts and Node built-ins (it may not import
//     engine, so the ServiceCaller port lives in contracts);
//   - `reveal`, the one way to read a secret's value, joins exactly one more module on its
//     allow-list: runner's call module. Any other module that imports it fails the lint.
// The changelog's 1.2 entry names the new steps, settings and codes.
// See docs/specs/SPEC-32-declared-service-calls.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, before, test } from 'node:test';
import { changelogEntry } from '../support/plan-changelog.ts';
import { PACKAGES, REPOSITORY_ROOT } from '../support/repository.ts';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';

const TIMEOUT = 300_000;
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies', 'bundleDependencies', 'bundledDependencies'];
// Imported module names in TypeScript source: static imports, re-exports and dynamic imports.
const IMPORTED = /\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

const sourceFiles = (folder: string): string[] =>
  readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => join(entry.parentPath, entry.name));

const importsOf = (source: string): string[] => [...source.matchAll(IMPORTED)].map((match) => match[1] ?? '');

// The imports of `source` that are neither relative, a Node built-in nor one of `allowedPackages`.
const foreignImports = (source: string, allowedPackages: readonly string[]): string[] =>
  importsOf(source).filter((name) => !name.startsWith('./') && !name.startsWith('../') && !name.startsWith('node:') && !allowedPackages.includes(name));

// A protocol pack: a pack package, or a module under a packs folder.
const isPackImport = (name: string): boolean => /(^|[/@-])packs?([/-]|$)/.test(name);

// ---- Dependencies ---------------------------------------------------------------------------------

const PACKAGES_CHECKED = [
  { name: 'contracts', allowed: [] },
  { name: 'engine', allowed: ['@revisum/contracts'] },
  { name: 'runner', allowed: ['@revisum/contracts'] },
] as const;

for (const checked of PACKAGES_CHECKED) {
  test(`${checked.name}'s package manifest declares no runtime dependency`, { criterion: 'AC-SPEC-32-15' }, () => {
    const manifest: Record<string, unknown> = JSON.parse(readFileSync(join(PACKAGES, checked.name, 'package.json'), 'utf8'));
    const declared = DEPENDENCY_FIELDS.filter((field) => {
      const value = manifest[field];
      return value !== undefined && !(typeof value === 'object' && value !== null && Object.keys(value).length === 0);
    });
    assert.deepEqual(declared, []);
  });

  test(`every import in ${checked.name}'s sources is relative, a Node built-in or ${checked.allowed.join(', ') || 'nothing else'}`, { criterion: 'AC-SPEC-32-15' }, () => {
    const folder = join(PACKAGES, checked.name, 'src');
    const found = sourceFiles(folder).flatMap((file) =>
      foreignImports(readFileSync(file, 'utf8'), checked.allowed).map((name) => `${relative(PACKAGES, file)}: ${name}`));
    assert.deepEqual(found, []);
  });
}

test('neither contracts nor engine imports a protocol pack', { criterion: 'AC-SPEC-32-15' }, () => {
  const found = ['contracts', 'engine'].flatMap((name) => sourceFiles(join(PACKAGES, name, 'src')).flatMap((file) =>
    importsOf(readFileSync(file, 'utf8')).filter(isPackImport).map((imported) => `${relative(PACKAGES, file)}: ${imported}`)));
  assert.deepEqual(found, []);
});

test('the service call port, ServiceCaller, is declared in contracts, so runner needs nothing from engine', { criterion: 'AC-SPEC-32-15' }, () => {
  const declaring = sourceFiles(join(PACKAGES, 'contracts', 'src'))
    .filter((file) => /export\s+interface\s+ServiceCaller\b/.test(readFileSync(file, 'utf8')));
  assert.equal(declaring.length, 1, 'contracts declares ServiceCaller once');
});

// Mutant: the same checks find a planted pack import and a planted engine import in runner.
test('mutant: the checks report a pack import, a runner import of engine and an HTTP library', { criterion: 'AC-SPEC-32-15' }, () => {
  const planted = [
    "import { httpStep } from '@revisum/pack-http';",
    "export { request } from '../packs/http/request.ts';",
    "import { buildServiceRequest } from '@revisum/engine';",
    "const client = await import('undici');",
    "import type { ServiceCaller } from '@revisum/contracts';",
    "import { request } from 'node:http';",
  ].join('\n');
  assert.deepEqual(importsOf(planted).filter(isPackImport), ['@revisum/pack-http', '../packs/http/request.ts']);
  assert.deepEqual(foreignImports(planted, ['@revisum/contracts']), ['@revisum/pack-http', '@revisum/engine', 'undici']);
  // Ordinary words that merely contain "pack" are not packs.
  assert.deepEqual(['./package-manifest.ts', 'node:zlib', '../unpacked.ts'].filter(isPackImport), []);
});

// ---- The reveal allow-list -------------------------------------------------------------------------

const REVEAL_CHECK = 'tools/check-secret-reveal.ts';
// The allow-list before SPEC-32: the drivers' input modules and the engine's secret values module.
const EARLIER_ALLOWED = [
  'packages/driver-cdp/src/browser-session.ts',
  'packages/driver-playwright/src/playwright-driver.ts',
  'packages/engine/src/secrets/secret-values.ts',
];

// The paths in the REVEAL_ALLOWED_MODULES list, read from the check's source.
function revealAllowList(): string[] {
  const source = readFileSync(join(REPOSITORY_ROOT, REVEAL_CHECK), 'utf8');
  const list = /REVEAL_ALLOWED_MODULES[^=]*=\s*\[([^\]]*)\]/.exec(source);
  assert.ok(list?.[1] !== undefined, `${REVEAL_CHECK} has no REVEAL_ALLOWED_MODULES list`);
  return [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
}

test('the reveal allow-list gains exactly one module, and it is in runner', { criterion: 'AC-SPEC-32-12' }, () => {
  const allowed = revealAllowList();
  const added = allowed.filter((path) => !EARLIER_ALLOWED.includes(path));
  assert.equal(added.length, 1, `modules added to the allow-list: ${JSON.stringify(added)}`);
  assert.match(added[0] ?? '', /^packages\/runner\/src\/[a-z0-9-]+\.ts$/);
  assert.deepEqual(EARLIER_ALLOWED.filter((path) => !allowed.includes(path)), [], 'an earlier module left the allow-list');
});

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

function assertLintFailsOn(relativePath: string, lines: readonly string[]): void {
  const outcome = scratch.lintWith(relativePath, [...lines, ''].join('\n'));
  assert.equal(outcome.passed, false, `the lint accepted ${relativePath}`);
  const fileName = relativePath.split('/').at(-1) ?? relativePath;
  assert.ok(outcome.failureOutput.includes(fileName), `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`);
}

test('the lint fails when another runner module imports reveal', { criterion: 'AC-SPEC-32-12', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/runner/src/planted-request-log.ts', [
    "import { reveal } from '@revisum/contracts';",
    '// Logs the headers of a service request.',
    'export const headerText = (secret: Parameters<typeof reveal>[0]): string => reveal(secret);',
  ]);
});

test('the lint fails when an engine module other than the secret values module imports reveal', { criterion: 'AC-SPEC-32-12', timeout: TIMEOUT }, () => {
  assertLintFailsOn('packages/engine/src/planted-request-builder.ts', [
    "import { reveal as show } from '@revisum/contracts';",
    '// Builds an authorization header as text.',
    'export const bearerHeader = (secret: Parameters<typeof show>[0]): string => `Bearer ${show(secret)}`;',
  ]);
});

// ---- The changelog ---------------------------------------------------------------------------------

const NAMED_IN_ENTRY = [
  'call', 'expectBackend', 'cleanup', 'remember', 'calls', 'services', 'maximumCalls', 'backendCheckTimeoutMilliseconds',
  'unsafe_interpolation', 'header_not_allowed', 'side-effect-in-proposal', 'parameter-invalid', 'unexpected-status',
  'call-timeout', 'service-unreachable', 'egress-blocked', 'response-not-json', 'response-too-large', 'field-missing', 'cleanup-failed',
];

test('the 1.2 changelog entry names the call steps, settings and codes, in code type', { criterion: 'AC-SPEC-30-02' }, () => {
  const entry = changelogEntry('1.2');
  assert.match(entry, /^## 1\.2\b/);
  assert.deepEqual(NAMED_IN_ENTRY.filter((name) => !entry.includes(`\`${name}\``)), [], 'names the 1.2 entry leaves out');
});

// ---- A 1.2 golden plan for calls --------------------------------------------------------------------

test('a 1.2 golden plan uses a call that remembers a field, an expectBackend and cleanup', { criterion: 'AC-SPEC-30-02' }, () => {
  const folder = join(REPOSITORY_ROOT, 'golden', 'plans');
  const plans = readdirSync(folder).filter((name) => name.endsWith('.json'))
    .map((name): Record<string, unknown> => JSON.parse(readFileSync(join(folder, name), 'utf8')))
    .filter((plan) => plan['version'] === '1.2');
  const stepsOf = (plan: Record<string, unknown>): Record<string, unknown>[] => (Array.isArray(plan['steps']) ? plan['steps'] : []);
  const uses = plans.filter((plan) =>
    stepsOf(plan).some((step) => step['type'] === 'call' && step['remember'] !== undefined)
    && stepsOf(plan).some((step) => step['type'] === 'expectBackend')
    && Array.isArray(plan['cleanup']) && plan['cleanup'].length > 0);
  assert.ok(uses.length > 0, 'no 1.2 golden plan uses calls, a backend check and cleanup');
});
