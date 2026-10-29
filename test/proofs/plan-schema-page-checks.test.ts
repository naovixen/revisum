// The page checks, downloads and second tab join plan language 1.2's published schema. golden/plans/
// holds a 1.2 golden plan for each of them, `npm run lint` validates every golden plan against the
// schema, and the changelog's one 1.2 entry names each new step, check, setting and error code.
// The schema-hash and entry-format checks are in plan-schema-newer-version.test.ts.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { changelogEntry } from '../support/plan-changelog.ts';
import { GOLDEN, REPOSITORY_ROOT } from '../support/repository.ts';
import { copyRepository, type LintOutcome, type ScratchRepository } from './scratch-repository.ts';

const DOWNLOAD_PLAN_PATH = 'golden/plans/export-download.json';
const TIMEOUT = 300_000;

type JsonRecord = Record<string, unknown>;

const readText = (relativePath: string): string => readFileSync(join(REPOSITORY_ROOT, relativePath), 'utf8');

const newerGoldenPlans = (): JsonRecord[] =>
  readdirSync(join(GOLDEN, 'plans')).filter((name) => name.endsWith('.json')).sort()
    .map((name): JsonRecord => JSON.parse(readFileSync(join(GOLDEN, 'plans', name), 'utf8')))
    .filter((plan) => plan['version'] === '1.2');

// Every object inside a JSON value, depth first.
const objectsIn = (value: unknown): JsonRecord[] => {
  if (Array.isArray(value)) return value.flatMap(objectsIn);
  if (typeof value !== 'object' || value === null) return [];
  const record: JsonRecord = { ...value };
  return [record, ...Object.values(record).flatMap(objectsIn)];
};

const usesKind = (kind: string) => (plan: JsonRecord): boolean => objectsIn(plan['steps']).some((object) => object['kind'] === kind);
const usesStep = (type: string) => (plan: JsonRecord): boolean => objectsIn(plan['steps']).some((object) => object['type'] === type);

const STATES = ['selected', 'unselected', 'expanded', 'collapsed', 'pressed', 'unpressed', 'current'];
const DOWNLOAD_CHECKS = ['fileNameEquals', 'mediaTypeEquals', 'sizeAtLeast', 'sizeAtMost', 'contentContains', 'contentExcludes'];

const FEATURES: Readonly<Record<string, (plan: JsonRecord) => boolean>> = {
  ...Object.fromEntries(STATES.map((state) => [`the state check "${state}"`, usesKind(state)])),
  'a link-target check': usesKind('hrefEquals'),
  'a meta tag check': usesKind('metaContent'),
  'a canonical URL check': usesKind('canonicalUrl'),
  'a server-rendered view': (plan) => objectsIn(plan['steps']).some((object) => object['type'] === 'navigate' && object['scripts'] === 'disabled'),
  'a download': usesStep('download'),
  ...Object.fromEntries(DOWNLOAD_CHECKS.map((kind) => [`the download check "${kind}"`, (plan: JsonRecord) => usesStep('expectDownload')(plan) && usesKind(kind)(plan)])),
  'a second tab': usesStep('newTab'),
};

for (const [feature, uses] of Object.entries(FEATURES)) {
  test(`a 1.2 golden plan uses ${feature}`, { criterion: 'AC-SPEC-30-02' }, () => {
    assert.ok(newerGoldenPlans().some(uses), `no golden plan declaring 1.2 uses ${feature}`);
  });
}

// ---- The changelog's 1.2 entry --------------------------------------------------------------------

const NAMED_IN_ENTRY = [
  ...STATES, 'hrefEquals', 'metaContent', 'canonicalUrl', 'scripts', 'download', 'expectDownload', ...DOWNLOAD_CHECKS, 'newTab',
  'maximumDownloadBytes', 'keepDownloads', 'misplaced_step', 'state-not-exposed', 'download-not-text', 'no-download', 'download-too-large',
];

test('the 1.2 changelog entry names each new step, check, setting and error code, in code type', { criterion: 'AC-SPEC-30-02' }, () => {
  const entry = changelogEntry('1.2');
  assert.match(entry, /^## 1\.2\b/);
  assert.deepEqual(NAMED_IN_ENTRY.filter((name) => !entry.includes(`\`${name}\``)), [], 'names the 1.2 entry leaves out');
});

// ---- The lint check -------------------------------------------------------------------------------

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

function assertFailsNaming(outcome: LintOutcome, fileName: string): void {
  assert.equal(outcome.passed, false, 'the lint passed');
  assert.ok(outcome.failureOutput.includes(fileName), `the lint failed, but did not name ${fileName}:\n${outcome.failureOutput}`);
}

const downloadPlan = (): JsonRecord => JSON.parse(readText(DOWNLOAD_PLAN_PATH));
const stepsOf = (plan: JsonRecord): JsonRecord[] => {
  const steps = plan['steps'];
  assert.ok(Array.isArray(steps));
  return steps;
};

test('the lint fails when a golden plan turns scripts "enabled" on a navigate', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const plan = downloadPlan();
  const opening = stepsOf(plan)[0];
  assert.ok(opening !== undefined && opening['type'] === 'navigate');
  opening['scripts'] = 'enabled';
  assertFailsNaming(scratch.lintWith('golden/plans/planted-scripts.json', `${JSON.stringify(plan, null, 2)}\n`), 'planted-scripts.json');
});

test('the lint fails when a golden plan checks a download with a kind the language does not have', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const plan = downloadPlan();
  const check = stepsOf(plan).find((step) => step['type'] === 'expectDownload');
  assert.ok(check !== undefined);
  check['assert'] = { kind: 'pageCountEquals', value: 3 };
  assertFailsNaming(scratch.lintWith('golden/plans/planted-download-check.json', `${JSON.stringify(plan, null, 2)}\n`), 'planted-download-check.json');
});

// Counter-example: a valid copy of the download plan passes, so the failures above come from the
// planted problems.
test('the lint accepts a new 1.2 golden plan with a download, a page check and a second tab', { criterion: 'AC-SPEC-30-02', timeout: TIMEOUT }, () => {
  const plan = downloadPlan();
  (plan['meta'] as JsonRecord)['title'] = 'Exporting the visible projects, second copy';
  stepsOf(plan).push({
    type: 'newTab', url: '/projects', steps: [
      { type: 'expect', locator: { by: 'role', role: 'tab', name: 'Active' }, assert: { kind: 'selected' }, criterionId: 'projects.active-tab-selected' },
    ],
  });
  const outcome = scratch.lintWith('golden/plans/planted-valid-download.json', `${JSON.stringify(plan, null, 2)}\n`);
  assert.equal(outcome.passed, true, outcome.failureOutput);
});
