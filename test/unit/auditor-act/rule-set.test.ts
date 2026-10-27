// Accessibility engine checks that need no browser: dependencies, rule metadata, criterion coverage,
// the pinned ACT data and the Finding type guard.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { ALL_RULES, isFinding, pageOutcome } from '@revisum/auditor-act';
import { ACT_TEST_CASES } from '../../support/accessibility-server.ts';
import { FIXTURES, PACKAGES } from '../../support/repository.ts';

const ENGINE_PACKAGE = join(PACKAGES, 'auditor-act');
const readJson = <Value>(path: string): Value => JSON.parse(readFileSync(path, 'utf8')) as Value;

function sourceFiles(folder: string, found: string[] = []): string[] {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) sourceFiles(path, found);
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}
const ENGINE_SOURCES = sourceFiles(join(ENGINE_PACKAGE, 'src'));
const isWorkspacePackage = (specifier: string): boolean => specifier.startsWith('@revisum/');

test('the engine has no third-party runtime dependency, and its sources import only Node built-ins, local files or workspace packages', { criterion: 'AC-SPEC-00-02' }, () => {
  const manifest = readJson<{ dependencies?: Record<string, string> }>(join(ENGINE_PACKAGE, 'package.json'));
  assert.deepEqual(Object.keys(manifest.dependencies ?? {}).filter((name) => !isWorkspacePackage(name)), []);
  for (const file of ENGINE_SOURCES) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
      const specifier = match[1] ?? '';
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.') || isWorkspacePackage(specifier), `${basename(file)} imports ${specifier}`);
    }
  }
});

test('no engine source mentions or imports axe-core, which stays pinned at 4.14.0 in its own auditor', () => {
  for (const file of ENGINE_SOURCES) assert.ok(!/axe/i.test(readFileSync(file, 'utf8')), `${basename(file)} mentions axe`);
  const axeAuditor = readJson<{ dependencies?: Record<string, string> }>(join(PACKAGES, 'auditor-axe', 'package.json'));
  assert.equal(axeAuditor.dependencies?.['axe-core'], '4.14.0');
});

test('every ACT rule records its id, W3C source URL and success criteria, and the id exists in the pinned test cases', () => {
  const pinnedCases = readJson<{ testcases: { ruleId: string }[] }>(join(ACT_TEST_CASES, 'testcases.json'));
  const ruleIds = new Set(pinnedCases.testcases.map((testCase) => testCase.ruleId));
  const actRules = ALL_RULES.filter((rule) => rule.meta.kind === 'act-rule');
  assert.ok(actRules.length >= 20);
  for (const rule of actRules) {
    assert.ok(ruleIds.has(rule.meta.id), rule.meta.id);
    assert.match(rule.meta.source, /^https:\/\/www\.w3\.org\/WAI\/standards-guidelines\/act\/rules\/[a-z0-9]{6}\//);
    assert.ok(rule.meta.source.includes(rule.meta.id));
    assert.ok(rule.meta.successCriteria.length > 0 && rule.meta.successCriteria.every((criterion) => /^\d\.\d\.\d{1,2}$/.test(criterion)));
    assert.ok(existsSync(join(ACT_TEST_CASES, 'rules', `${rule.meta.id}.html`)), `rule text pinned for ${rule.meta.id}`);
  }
  for (const rule of ALL_RULES.filter((candidate) => candidate.meta.kind === 'probe')) assert.match(rule.meta.source, /^https:\/\/www\.w3\.org\/TR\/WCAG22\/#/);
});

const covered = new Set(ALL_RULES.flatMap((rule) => rule.meta.successCriteria));

test('the rule set covers every success criterion where axe-core detected a seeded failure, except the listed uncovered ones', () => {
  const axeResults = readJson<{ results: { sc: string; detected: boolean }[] }>(join(FIXTURES, 'mapping-pairs', 'axe-results.json'));
  const axeCriteria = [...new Set(axeResults.results.filter((result) => result.detected).map((result) => result.sc))];
  const uncovered = readJson<{ criteria: { criterion: string }[] }>(join(FIXTURES, 'mapping-pairs', 'criteria-without-own-rule.json'));
  const listed = uncovered.criteria.map((entry) => entry.criterion);
  assert.ok(axeCriteria.length >= 15);
  for (const criterion of axeCriteria) assert.ok(covered.has(criterion) || listed.includes(criterion), `SC ${criterion} neither covered nor listed`);
  for (const criterion of listed) assert.ok(!covered.has(criterion), `SC ${criterion} listed as uncovered but covered`);
});

test('at least 3 success criteria with no axe-core rule in the WCAG mapping are covered', () => {
  const mapping = readJson<{ mapping: { num: string; axe_rules: string[] }[] }>(join(FIXTURES, 'mapping-pairs', 'wcag-axe-mapping.json'));
  const axeLacks = mapping.mapping.filter((row) => row.axe_rules.length === 0 && covered.has(row.num)).map((row) => row.num);
  assert.ok(axeLacks.length >= 3, axeLacks.join(','));
});

test('ACT data is pinned with date, sha256, licence and every case file for the implemented rules', () => {
  const pin = readJson<{ retrieved: string; sha256_testcases: string; licence: string; rules: string[] }>(join(ACT_TEST_CASES, 'pin.json'));
  assert.match(pin.retrieved, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(pin.sha256_testcases, /^[0-9a-f]{64}$/);
  assert.match(pin.licence, /^https:\/\//);
  const raw = readFileSync(join(ACT_TEST_CASES, 'testcases.json'));
  assert.equal(createHash('sha256').update(raw).digest('hex'), pin.sha256_testcases);
  const pinnedCases = JSON.parse(raw.toString('utf8')) as { testcases: { ruleId: string; relativePath: string }[] };
  const implemented = new Set(ALL_RULES.filter((rule) => rule.meta.kind === 'act-rule').map((rule) => rule.meta.id));
  for (const id of implemented) assert.ok(pin.rules.includes(id), `pinned rule list includes ${id}`);
  const casesOfImplemented = pinnedCases.testcases.filter((testCase) => implemented.has(testCase.ruleId));
  assert.ok(casesOfImplemented.length > 300);
  for (const testCase of casesOfImplemented) assert.ok(existsSync(join(ACT_TEST_CASES, testCase.relativePath)), testCase.relativePath);
});

test('the Finding type guard accepts a well-formed finding and rejects malformed ones', () => {
  const wellFormed = {
    page: 'x', ruleId: 'afw4f7', kind: 'act-rule', wcag: ['1.4.3'], severity: 'P2', outcome: 'failed', selector: ['p'],
    box: { x: 0, y: 0, width: 10, height: 10 }, message: '',
  };
  assert.ok(isFinding(wellFormed));
  assert.ok(!isFinding({ ...wellFormed, severity: 'P9' }));
  assert.ok(!isFinding({ ...wellFormed, selector: [] }));
  assert.ok(!isFinding({ ...wellFormed, wcag: ['1.4'] }));
  assert.ok(!isFinding({ ...wellFormed, box: { x: 0, y: 0, width: -1, height: 1 } }));
  assert.equal(pageOutcome([]), 'inapplicable');
  assert.equal(pageOutcome([{ node: 1, outcome: 'passed', message: '' }, { node: 2, outcome: 'failed', message: '' }]), 'failed');
});
