// Every third-party package on the trust path needs a dependency review, and a review that fails a
// check cannot keep its package on the default path. The trust path is every package the lock
// file installs as a non-development dependency of a workspace package; the reviews live in
// tools/dependency-reviews.ts. Each test plants one change in a throw-away copy of the repository
// and runs the repository's lint commands over it:
//   - a new runtime dependency with no review fails, naming it;
//   - a `default` review with a failing check fails, naming the package;
//   - a review whose version is not the installed one, or whose evidence path is missing, fails;
//   - a development-only package, a `partial` result and a failing optional adapter all pass,
//     so the lint fails for the planted reason only.
// See docs/specs/SPEC-00-repo-seed-and-gates.md.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';
import { assertLintFails, assertLintPasses, editJson, lintWithEdits } from './scratch-edits.ts';

const REVIEWS_PATH = 'tools/dependency-reviews.ts';
const LOCK_PATH = 'package-lock.json';
const PLANTED_PACKAGE = 'left-pad';
const PLANTED_VERSION = '1.3.0';
const PLANTED_LOCK_ENTRY = {
  version: PLANTED_VERSION,
  resolved: `https://registry.npmjs.org/${PLANTED_PACKAGE}/-/${PLANTED_PACKAGE}-${PLANTED_VERSION}.tgz`,
  integrity: 'sha512-XI5MPzVNApjAyhQzphX8BkmKsKUxD4LdyK24iZeQYqvNYSgD3Pz/4LZaFhKOpd+5FSzIzAa9a+DECsoJiMWiFg==',
  license: 'WTFPL',
};
const TIMEOUT = 300_000;

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

type JsonObject = Record<string, unknown>;
const recordAt = (value: JsonObject, key: string): JsonObject => {
  const found = value[key];
  if (typeof found === 'object' && found !== null && !Array.isArray(found)) return found as JsonObject;
  const created: JsonObject = {};
  value[key] = created;
  return created;
};

// Adds the planted package as a runtime dependency of packages/report: its manifest, the lock
// file's record of that workspace, and the installed package's own lock entry.
const runtimeDependencyEdits = {
  'packages/report/package.json': editJson((manifest) => { recordAt(manifest, 'dependencies')[PLANTED_PACKAGE] = PLANTED_VERSION; }),
  [LOCK_PATH]: editJson((lock) => {
    const packages = recordAt(lock, 'packages');
    recordAt(recordAt(packages, 'packages/report'), 'dependencies')[PLANTED_PACKAGE] = PLANTED_VERSION;
    packages[`node_modules/${PLANTED_PACKAGE}`] = { ...PLANTED_LOCK_ENTRY };
  }),
};

// The same package as a development dependency of the repository root only.
const developmentDependencyEdits = {
  'package.json': editJson((manifest) => { recordAt(manifest, 'devDependencies')[PLANTED_PACKAGE] = PLANTED_VERSION; }),
  [LOCK_PATH]: editJson((lock) => {
    const packages = recordAt(lock, 'packages');
    recordAt(recordAt(packages, ''), 'devDependencies')[PLANTED_PACKAGE] = PLANTED_VERSION;
    packages[`node_modules/${PLANTED_PACKAGE}`] = { ...PLANTED_LOCK_ENTRY, dev: true };
  }),
};

// Replaces the first quoted `from` result that follows `component` in the reviews source.
function replaceResultAfter(component: string, from: string, to: string): (text: string) => string {
  return (text) => {
    const start = text.indexOf(component);
    if (start < 0) throw new Error(`${REVIEWS_PATH} does not mention ${component}`);
    const rest = text.slice(start);
    const match = new RegExp(`(['"])${from}\\1`).exec(rest);
    if (match === null) throw new Error(`no '${from}' result follows ${component} in ${REVIEWS_PATH}`);
    const quote = match[1] ?? "'";
    return text.slice(0, start) + rest.slice(0, match.index) + `${quote}${to}${quote}` + rest.slice(match.index + match[0].length);
  };
}

test('control: the unchanged copy of the repository passes every lint command', { criterion: 'AC-SPEC-00-04', timeout: TIMEOUT }, () => {
  assertLintPasses(scratch.lint());
});

// ---- A component with no review -----------------------------------------------------------------

test('the lint fails when a workspace package gains a runtime dependency that has no review', { criterion: 'AC-SPEC-00-04', timeout: TIMEOUT }, () => {
  assertLintFails(lintWithEdits(scratch, runtimeDependencyEdits), [PLANTED_PACKAGE]);
});

test('counter-example: the same package as a development dependency needs no review', { criterion: 'AC-SPEC-00-04', timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithEdits(scratch, developmentDependencyEdits));
});

// ---- A failing check on the default path --------------------------------------------------------

test('the lint fails when the default axe-core review is given a failing check', { criterion: 'AC-SPEC-00-04', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, { [REVIEWS_PATH]: replaceResultAfter('axe-core', 'pass', 'fail') });
  assertLintFails(outcome, ['axe-core']);
});

test('the lint fails when playwright-core, which fails two checks, is moved onto the default path', { criterion: 'AC-SPEC-00-04', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    [REVIEWS_PATH]: (text) => text.replace(/(['"])optional-adapter\1/, (_match, quote: string) => `${quote}default${quote}`),
  });
  assertLintFails(outcome, ['playwright-core']);
});

test('counter-example: a partial result on the default path passes', { criterion: 'AC-SPEC-00-04', timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithEdits(scratch, { [REVIEWS_PATH]: replaceResultAfter('axe-core', 'pass', 'partial') }));
});

// ---- The review matches what is installed, and its evidence exists ------------------------------

test('the lint fails when a review names a version other than the one installed', { criterion: 'AC-SPEC-00-04', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, { [REVIEWS_PATH]: (text) => text.replace('4.14.0', '4.13.0') });
  assertLintFails(outcome, ['axe-core']);
});

test('the lint fails when a review cites a repository path that does not exist', { criterion: 'AC-SPEC-00-04', timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    [REVIEWS_PATH]: (text) => {
      // The first quoted repository path the reviews cite as evidence.
      const cited = [...text.matchAll(/(['"])([\w.-]+(?:\/[\w.-]+)+\.\w+)\1/g)]
        .map((match) => match[2] ?? '')
        .find((path) => path !== '' && existsSync(join(scratch.root, path)));
      if (cited === undefined) throw new Error(`${REVIEWS_PATH} cites no repository path as evidence`);
      return text.split(cited).join('docs/decisions/missing-dependency-review.md');
    },
  });
  assertLintFails(outcome, ['missing-dependency-review.md']);
});
