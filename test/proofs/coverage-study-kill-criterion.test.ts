// The coverage study's report shows the closed-language share and the "1.3 with unsafe features"
// share side by side, and its kill-criterion line is decided by the closed share alone: unsafe
// features are escape hatches, and the language-fit criterion counts intents expressible without
// one. Each test plants a study file in a throw-away copy of the repository, runs the study tool
// there and reads the report it writes. The study is built from
// fixtures/coverage-study/unsafe-features.json (see coverage-study-unsafe-features.test.ts).
// See docs/specs/SPEC-36-unsafe-plan-features.md and docs/specs/SPEC-01-plan-language-and-parser.md.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { FIXTURES } from '../support/repository.ts';
import { copyRepository, type ScratchRepository } from './scratch-repository.ts';

const TIMEOUT = 300_000;
const STUDY_PATH = join('docs', 'coverage-study', 'intents.json');
const REPORT_PATH = join('docs', 'coverage-study', 'report.md');

type JsonRecord = Record<string, unknown>;

const fixtureStudy = (): JsonRecord => JSON.parse(readFileSync(join(FIXTURES, 'coverage-study', 'unsafe-features.json'), 'utf8'));
// The fixture study keeping only the intents at `indexes`.
const studyOf = (indexes: readonly number[]): JsonRecord => {
  const study = fixtureStudy();
  return { ...study, intents: (study['intents'] as unknown[]).filter((_, index) => indexes.includes(index)) };
};

let scratch: ScratchRepository;
before(() => { scratch = copyRepository(); });
after(() => { scratch.dispose(); });

// Runs the study tool in the copy on `study` and returns the report it wrote.
function reportFor(study: JsonRecord): string {
  writeFileSync(join(scratch.root, STUDY_PATH), `${JSON.stringify(study, null, 2)}\n`);
  const ran = spawnSync(process.execPath, [join('tools', 'coverage-study.ts')], { cwd: scratch.root, encoding: 'utf8', timeout: 120_000 });
  assert.equal(ran.status, 0, `the study tool failed:\n${ran.stdout}${ran.stderr}`);
  return readFileSync(join(scratch.root, REPORT_PATH), 'utf8');
}

const killLine = (report: string): string => {
  const lines = report.split(/\r?\n/).filter((line) => line.includes('kill criterion'));
  assert.equal(lines.length, 1, `expected one kill-criterion line:\n${report}`);
  return lines[0] ?? '';
};

// Intents 0 and 5 are closed; 1 and 4 use unsafe features their suite enables.
// Closed share 2 of 4 (50.0%); with unsafe features 4 of 4 (100.0%).
const HALF_CLOSED = [0, 1, 4, 5];

test('the report shows the closed share and the share with unsafe features side by side', { criterion: 'AC-SPEC-36-19', timeout: TIMEOUT }, () => {
  const report = reportFor(studyOf(HALF_CLOSED));
  assert.ok(report.includes('1.3 with unsafe features'), `the second share is not named:\n${report}`);
  assert.ok(report.includes('50.0%'), `the closed share is missing:\n${report}`);
  assert.ok(report.includes('100.0%'), `the share with unsafe features is missing:\n${report}`);
});

test('with the share with unsafe features at 100% and the closed share at 50%, the kill criterion is not met', { criterion: 'AC-SPEC-36-19', timeout: TIMEOUT }, () => {
  const line = killLine(reportFor(studyOf(HALF_CLOSED)));
  assert.match(line, /not met/);
  assert.ok(!line.includes('100.0%'), `the kill-criterion line quotes the share with unsafe features: ${line}`);
});

// Counter-example: a study whose closed share passes the threshold meets the criterion, so the
// line above can say "met" and its "not met" came from the closed share.
test('with every intent closed and expressible, the kill criterion is met', { criterion: 'AC-SPEC-36-19', timeout: TIMEOUT }, () => {
  const line = killLine(reportFor(studyOf([0, 5])));
  assert.match(line, /\bmet\b/);
  assert.doesNotMatch(line, /not met/);
});
