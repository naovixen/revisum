// The licence check gives each package a role and each role a licence: schemas, SDKs, drivers and
// adapters carry Apache-2.0; the engine carries FSL-1.1-ALv2; product packages may carry either.
// Every published JSON Schema is listed as Apache-2.0. axe-core's MPL-2.0 files must be the pinned
// release byte for byte, at the pinned version, and never copied into a package.
// Each test plants one change in a throw-away copy of the repository and runs the lint commands.
// A licence change is planted in both licences.json and the package's manifest, so the two still
// agree and only the role rule can catch it. For axe-core the copy gets its own installed-packages
// folder: every package links to the real one, except axe-core, which is copied and then edited.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { cpSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { REPOSITORY_ROOT } from '../support/repository.ts';
import { copyRepository, type LintOutcome, type ScratchRepository } from './scratch-repository.ts';
import { assertLintFails, assertLintPasses, editJson, lintWithEdits } from './scratch-edits.ts';

const LICENCE_CHECK = 'check-licences';
const APACHE = 'Apache-2.0';
const FSL = 'FSL-1.1-ALv2';
const TIMEOUT = 300_000;

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

// Gives a package another licence in licences.json and in its own manifest.
function relicense(folder: string, licence: string): LintOutcome {
  return lintWithEdits(scratch, {
    'licences.json': editJson((map) => {
      const packages = map['packages'];
      if (typeof packages !== 'object' || packages === null) throw new Error('licences.json has no packages map');
      Object.assign(packages, { [folder]: licence });
    }),
    [`packages/${folder}/package.json`]: editJson((manifest) => { manifest['license'] = licence; }),
  });
}

test('control: the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-00-08', timeout: TIMEOUT }, () => {
  assertLintPasses(scratch.lint());
});

// ---- Licences by role ---------------------------------------------------------------------------

for (const [folder, role] of [['contracts', 'schema'], ['action', 'SDK'], ['driver-cdp', 'driver'], ['driver-playwright', 'driver'], ['report', 'adapter'], ['auditor-axe', 'adapter']] as const) {
  test(`the licence check fails when ${folder}, a ${role} package, carries the engine licence`, { criterion: 'AC-SPEC-00-08', timeout: TIMEOUT }, () => {
    assertLintFails(relicense(folder, FSL), [folder], LICENCE_CHECK);
  });
}

test('the licence check fails when the engine carries Apache-2.0', { criterion: 'AC-SPEC-00-08', timeout: TIMEOUT }, () => {
  assertLintFails(relicense('engine', APACHE), ['engine'], LICENCE_CHECK);
});

test('counter-example: a product package may carry Apache-2.0 instead of the engine licence', { criterion: 'AC-SPEC-00-08', timeout: TIMEOUT }, () => {
  assertLintPasses(relicense('cli', APACHE));
});

test('the licence check fails on a published JSON Schema that licences.json does not list', { criterion: 'AC-SPEC-00-08', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    'docs/plan-language/project.schema.json': '{ "$schema": "https://json-schema.org/draft/2020-12/schema", "type": "object" }\n',
  });
  assertLintFails(outcome, ['project.schema.json'], LICENCE_CHECK);
});

// ---- axe-core's files are the pinned release ----------------------------------------------------

// Gives the copy its own node_modules in place of the link to the real one: every entry links to
// the real entry, except axe-core, which is copied so `edit` can change it. The link to the
// real node_modules is put back afterwards; nothing under the real folder is ever written.
function lintWithInstalledAxe(edit: (axeFolder: string) => void): LintOutcome {
  const realModules = join(REPOSITORY_ROOT, 'node_modules');
  const modules = join(scratch.root, 'node_modules');
  unlinkSync(modules);
  mkdirSync(modules);
  const linked: string[] = [];
  const copied: string[] = [];
  try {
    for (const entry of readdirSync(realModules, { withFileTypes: true })) {
      const source = join(realModules, entry.name);
      const target = join(modules, entry.name);
      if (entry.name === 'axe-core') {
        cpSync(source, target, { recursive: true });
        copied.push(target);
      } else if (entry.isFile()) {
        copyFileSync(source, target);
        copied.push(target);
      } else {
        symlinkSync(source, target, 'junction');
        linked.push(target);
      }
    }
    edit(join(modules, 'axe-core'));
    return scratch.lint();
  } finally {
    // Links first, so removing the copies can never reach the real packages.
    for (const target of linked) unlinkSync(target);
    for (const target of copied) rmSync(target, { recursive: true, force: true });
    rmSync(modules, { recursive: true, force: true });
    symlinkSync(realModules, modules, 'junction');
  }
}

test('control: an unedited copy of the installed axe-core passes', { criterion: 'AC-SPEC-00-08', timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithInstalledAxe(() => {}));
});

for (const file of ['axe.min.js', 'axe.js']) {
  test(`the licence check fails when the installed ${file} differs from the pinned release by one byte`, { criterion: 'AC-SPEC-00-08', timeout: TIMEOUT }, () => {
    const outcome = lintWithInstalledAxe((folder) => {
      const path = join(folder, file);
      writeFileSync(path, `${readFileSync(path, 'utf8')} `);
    });
    assertLintFails(outcome, [file], LICENCE_CHECK);
  });
}

test('the licence check fails when the installed axe-core is not the pinned version', { criterion: 'AC-SPEC-00-08', timeout: TIMEOUT }, () => {
  const outcome = lintWithInstalledAxe((folder) => {
    const path = join(folder, 'package.json');
    const manifest: Record<string, unknown> = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, `${JSON.stringify({ ...manifest, version: '4.13.0' }, null, 2)}\n`);
  });
  assertLintFails(outcome, ['axe-core', '4.13.0'], LICENCE_CHECK);
});

test('the licence check fails when a package holds a copy of axe.min.js', { criterion: 'AC-SPEC-00-08', timeout: TIMEOUT }, () => {
  const axe = readFileSync(join(REPOSITORY_ROOT, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
  const outcome = lintWithEdits(scratch, { 'packages/auditor-axe/src/axe.min.js': axe });
  assertLintFails(outcome, ['axe.min.js'], LICENCE_CHECK);
});
