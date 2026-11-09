// Every third-party package on the trust path needs a dependency review, and a review that fails a
// check cannot keep its package on the default path. The trust path is every package the lock
// file installs as a non-development dependency of a workspace package; the reviews live in
// tools/repo-rules/docs/DependencyReviews.ts. Each test plants one change in a throw-away copy of the repository
// and runs the repository's lint commands over it:
//   - a new runtime dependency with no review fails, naming it;
//   - a `default` review with a failing check fails, naming the package;
//   - a review whose version is not the installed one, or whose evidence path is missing, fails;
//   - a development-only package and a `partial` result both pass, so the lint fails for the
//     planted reason only.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { RepositoryRuleName } from '../../../../tools/repo-rules/RunRepositoryRules.ts';
import { copyRepository, type ScratchRepository } from '../support/ScratchRepository.ts';
import { assertLintFails, assertLintPasses, editJson, lintWithEdits } from '../support/WithEdits.ts';

const REVIEWS_PATH = 'tools/repo-rules/docs/DependencyReviews.ts';
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

const ONLY_THE_RULE = { rule: RepositoryRuleName.DependencyReviews };

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

type JsonObject = Record<string, unknown>;
const recordAt = (value: JsonObject, key: string): JsonObject => {
  const found = value[key];
  if (typeof found === 'object' && found !== null && !Array.isArray(found)) {return found as JsonObject;}
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

// Replaces the first `from` result that follows `component` in the reviews source.
function replaceResultAfter(component: string, from: string, to: string): (text: string) => string {
  return (text) => {
    const start = text.indexOf(component);
    if (start < 0) {throw new Error(`${REVIEWS_PATH} does not mention ${component}`);}
    const rest = text.slice(start);
    const result = `DependencyCheckResult.${from}`;
    const index = rest.indexOf(result);
    if (index < 0) {throw new Error(`no ${result} follows ${component} in ${REVIEWS_PATH}`);}
    return text.slice(0, start) + rest.slice(0, index) + `DependencyCheckResult.${to}` + rest.slice(index + result.length);
  };
}

test('control: the unchanged copy of the repository passes every lint command', { timeout: TIMEOUT }, () => {
  assertLintPasses(scratch.lint());
});

// ---- A component with no review -----------------------------------------------------------------

test('the lint fails when a workspace package gains a runtime dependency that has no review', { timeout: TIMEOUT }, () => {
  assertLintFails(lintWithEdits(scratch, runtimeDependencyEdits, ONLY_THE_RULE), [PLANTED_PACKAGE]);
});

test('counter-example: the same package as a development dependency needs no review', { timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithEdits(scratch, developmentDependencyEdits));
});

// ---- A failing check on the default path --------------------------------------------------------

test('the lint fails when the default axe-core review is given a failing check', { timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, { [REVIEWS_PATH]: replaceResultAfter('axe-core', 'Pass', 'Fail') }, ONLY_THE_RULE);
  assertLintFails(outcome, ['axe-core']);
});

test('counter-example: a partial result on the default path passes', { timeout: TIMEOUT }, () => {
  assertLintPasses(lintWithEdits(scratch, { [REVIEWS_PATH]: replaceResultAfter('axe-core', 'Pass', 'Partial') }));
});

// ---- The review matches what is installed, and its evidence exists ------------------------------

test('the lint fails when a review names a version other than the one installed', { timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, { [REVIEWS_PATH]: (text) => text.replace('4.14.0', '4.13.0') }, ONLY_THE_RULE);
  assertLintFails(outcome, ['axe-core']);
});

test('the lint fails when a review cites a repository path that does not exist', { timeout: TIMEOUT }, () => {
  const outcome = lintWithEdits(scratch, {
    [REVIEWS_PATH]: (text) => {
      // The first quoted repository path the reviews cite as evidence.
      const cited = [...text.matchAll(/(['"])([\w.-]+(?:\/[\w.-]+)+\.\w+)\1/g)]
        .map((match) => match[2] ?? '')
        .find((path) => path !== '' && existsSync(join(scratch.root(), path)));
      if (cited === undefined) {throw new Error(`${REVIEWS_PATH} cites no repository path as evidence`);}
      return text.split(cited).join('docs/decisions/missing-dependency-review.md');
    },
  }, ONLY_THE_RULE);
  assertLintFails(outcome, ['missing-dependency-review.md']);
});
