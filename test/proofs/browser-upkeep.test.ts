// Browser upkeep: what each new Chrome for Testing major costs to re-validate, and when that cost
// says to return to the Playwright fallback.
//   node tools/browser-upkeep.ts [--records <file>]
//     decodes the upkeep records ({ browser, major, fixHours, revalidatedAt }, a JSON list; by
//     default docs/decisions/browser-upkeep.json) and prints the average fixHours over the first
//     six Chrome majors, to two decimals, with how many majors it covers. Over 1.8 it prints a flag
//     naming the Playwright fallback rule and exits 1. With fewer than six Chrome records it prints
//     the running average and never flags. Records that do not decode fail, naming the field.
//   node tools/browser-upkeep.ts [--records <file>] --versions <file> [--pinned <build>]
//     reads Chrome for Testing's version list (its last-known-good-versions.json shape) and compares
//     the Stable channel's major with the pinned build's (by default CHROME_FOR_TESTING_BUILD in
//     tools/install-browsers.ts). A newer major is named in the output; it fails when that major
//     has no upkeep record.
// A weekly scheduled CI job runs the tool and re-runs the contract and capability suites.
// Every test reads fixture files under fixtures/browser-upkeep/; none uses the network.
// See docs/specs/SPEC-06-cdp-driver.md.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { FIXTURES, REPOSITORY_ROOT } from '../support/repository.ts';
import { describeRun, runTool, type ToolRun } from '../support/tool-runs.ts';

const TOOL = 'browser-upkeep.ts';
const FALLBACK_FLAG = /Playwright fallback/i;
const fixture = (name: string): string => join(FIXTURES, 'browser-upkeep', name);
const upkeep = (words: readonly string[]): ToolRun => runTool(TOOL, words, { cwd: REPOSITORY_ROOT });
const summary = (records: string): ToolRun => upkeep(['--records', fixture(records)]);
const newMajorCheck = (records: string, versions: string, pinned = '156.0.8078.47'): ToolRun =>
  upkeep(['--records', fixture(records), '--versions', fixture(versions), '--pinned', pinned]);

function assertPassesWithout(run: ToolRun, unwanted: RegExp): void {
  assert.equal(run.passed, true, describeRun(run));
  assert.doesNotMatch(run.output, unwanted, describeRun(run));
}

// ---- The average and the flag ------------------------------------------------------------------

test('six Chrome majors averaging 2.00 fix hours flag the Playwright fallback rule and exit 1', { criterion: 'AC-SPEC-06-08' }, () => {
  const run = summary('six-majors-over-limit.json');
  assert.equal(run.status, 1, describeRun(run));
  assert.match(run.output, /\b2\.00\b/);
  assert.match(run.output, /\b6\b/);
  assert.match(run.output, FALLBACK_FLAG);
});

test('six Chrome majors averaging 1.50 fix hours pass with no flag', { criterion: 'AC-SPEC-06-08' }, () => {
  const run = summary('six-majors-under-limit.json');
  assertPassesWithout(run, FALLBACK_FLAG);
  assert.match(run.output, /\b1\.50\b/);
});

test('an average of exactly 1.8 hours is not over the limit, so it does not flag', { criterion: 'AC-SPEC-06-08' }, () => {
  const run = summary('six-majors-at-limit.json');
  assertPassesWithout(run, FALLBACK_FLAG);
  assert.match(run.output, /\b1\.80\b/);
});

test('only the first six Chrome majors count: later majors and Firefox records do not move the average', { criterion: 'AC-SPEC-06-08' }, () => {
  // All nine records would average 10.67 and flag; the six lowest Chrome majors average 1.00.
  const run = summary('later-majors-and-firefox.json');
  assertPassesWithout(run, FALLBACK_FLAG);
  assert.match(run.output, /\b1\.00\b/);
});

test('with fewer than six Chrome records the running average is reported and never flags', { criterion: 'AC-SPEC-06-08' }, () => {
  const run = summary('four-majors.json');
  assertPassesWithout(run, FALLBACK_FLAG);
  assert.match(run.output, /\b5\.00\b/);
  assert.match(run.output, /\b4\b/);
});

test('with no records yet the tool passes, flags nothing and prints no number it cannot compute', { criterion: 'AC-SPEC-06-08' }, () => {
  const run = summary('no-records.json');
  assertPassesWithout(run, FALLBACK_FLAG);
  assert.doesNotMatch(run.output, /NaN|Infinity/);
});

const INVALID_RECORDS = [
  { file: 'invalid-missing-fix-hours.json', fault: /fixHours/ },
  { file: 'invalid-negative-fix-hours.json', fault: /fixHours/ },
  // The fault named by the value that is wrong, or by its field.
  { file: 'invalid-browser.json', fault: /safari/ },
  { file: 'invalid-major.json', fault: /156\.5|\bmajor\b/ },
  { file: 'invalid-revalidated-at.json', fault: /revalidatedAt/ },
  { file: 'invalid-not-a-list.json', fault: /list|array/i },
] as const;

for (const invalid of INVALID_RECORDS) {
  test(`records that do not decode (${invalid.file}) fail and name the fault, without a verdict`, { criterion: 'AC-SPEC-06-08' }, () => {
    const run = summary(invalid.file);
    assert.equal(run.passed, false, describeRun(run));
    assert.match(run.output, invalid.fault, describeRun(run));
    assert.doesNotMatch(run.output, FALLBACK_FLAG);
  });
}

test('the repository\'s own upkeep records decode', { criterion: 'AC-SPEC-06-08' }, () => {
  assert.ok(existsSync(join(REPOSITORY_ROOT, 'docs', 'decisions', 'browser-upkeep.json')), 'docs/decisions/browser-upkeep.json exists');
  const run = upkeep([]);
  // Passing, or flagging the fallback rule, are both verdicts on decoded records.
  assert.ok(run.passed || FALLBACK_FLAG.test(run.output), describeRun(run));
});

// ---- A new Chrome for Testing major -----------------------------------------------------------

test('a newer Stable major with an upkeep record is named and passes', { criterion: 'AC-SPEC-06-08' }, () => {
  const run = newMajorCheck('with-major-157.json', 'versions-stable-157.json');
  assert.equal(run.passed, true, describeRun(run));
  assert.match(run.output, /\b157\b/);
});

test('a newer Stable major with no upkeep record fails, naming the major', { criterion: 'AC-SPEC-06-08' }, () => {
  const run = newMajorCheck('without-major-157.json', 'versions-stable-157.json');
  assert.equal(run.passed, false, describeRun(run));
  assert.match(run.output, /\b157\b/);
  assert.match(run.output, /upkeep record/i);
});

test('a newer build of the pinned major is not a new major, whatever Beta, Dev and Canary are', { criterion: 'AC-SPEC-06-08' }, () => {
  const run = newMajorCheck('without-major-157.json', 'versions-stable-156-patch.json');
  assert.equal(run.passed, true, describeRun(run));
  assert.doesNotMatch(run.output, /\b15[789]\b/);
});

test('without --pinned the check compares with the build tools/install-browsers.ts pins', { criterion: 'AC-SPEC-06-08' }, () => {
  const run = upkeep(['--records', fixture('with-major-157.json'), '--versions', fixture('versions-stable-999.json')]);
  assert.equal(run.passed, false, describeRun(run));
  assert.match(run.output, /\b999\b/);
});

test('a version list with no Stable version fails rather than passing', { criterion: 'AC-SPEC-06-08' }, () => {
  const run = newMajorCheck('with-major-157.json', 'versions-malformed.json');
  assert.equal(run.passed, false, describeRun(run));
  assert.match(run.output, /Stable/, 'the failure names the missing Stable version');
});

// ---- The weekly job ---------------------------------------------------------------------------

test('a weekly scheduled CI job runs the upkeep check and re-runs the contract and capability suites', { criterion: 'AC-SPEC-06-08' }, () => {
  const folder = join(REPOSITORY_ROOT, '.github', 'workflows');
  const scheduled = readdirSync(folder)
    .filter((name) => /\.ya?ml$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(folder, name), 'utf8') }))
    .filter((workflow) => /^\s*schedule:\s*$/m.test(workflow.text) && /^\s*-\s*cron:\s*['"]?[^'"\n]+['"]?\s*$/m.test(workflow.text));
  const upkeepJob = scheduled.find((workflow) => workflow.text.includes(`tools/${TOOL}`));
  assert.ok(upkeepJob, `no scheduled workflow runs tools/${TOOL}`);
  // Weekly: a fixed day of the week, any day of the month and any month.
  const cron = /^\s*-\s*cron:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(upkeepJob.text)?.[1] ?? '';
  const fields = cron.trim().split(/\s+/);
  assert.equal(fields.length, 5, `cron "${cron}"`);
  assert.deepEqual([fields[2], fields[3]], ['*', '*'], `cron "${cron}" runs on a day of the week`);
  assert.match(fields[4] ?? '', /^[0-6]$|^(SUN|MON|TUE|WED|THU|FRI|SAT)$/i, `cron "${cron}" runs once a week`);
  assert.ok(upkeepJob.text.includes('test/contract/driver-contract.test.ts') || upkeepJob.text.includes('test/contract'), 'the job re-runs the contract suite');
  assert.ok(upkeepJob.text.includes('test/contract/cdp-capabilities.test.ts') || upkeepJob.text.includes('test/contract'), 'the job re-runs the capability suite');
});
