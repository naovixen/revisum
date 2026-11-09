// The performance benchmark: never a gate, only a trend alarm.
//   node tools/scheduled/BenchmarkRuns.ts                     runs the sign-up plan 20 times on the headless shell
//     (setup time from calling run to the first step.start; peak memory the highest combined RSS of
//     Node and Chromium), then compares as below. These tests never run it: real timings would make
//     them flaky, and the benchmark runs only in its own weekly workflow.
//   node tools/scheduled/BenchmarkRuns.ts --samples <file> [--baseline <file>]
//     compares recorded runs instead: { platform, runs: [{ setupMilliseconds, peakMemoryMegabytes }] }.
//     On linux-x64 the medians of 20 runs are compared with the stored baseline ({ "linux-x64":
//     { setupMedianMilliseconds, peakMemoryMegabytes } }, by default
//     docs/decisions/benchmark-baseline.json). A median more than 30% over its baseline prints a
//     "::warning::" line naming the regression and adds a line to the job summary
//     ($GITHUB_STEP_SUMMARY). On arm64 the medians are recorded with no comparison. Whatever it finds,
//     the tool exits 0.
// Every test reads sample files under test/fixtures/tooling/benchmark/.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { FIXTURES, REPOSITORY_ROOT } from '../../../support/repository/RepositoryRoot.ts';
import { describeRun, runTool, type ToolRun } from '../../../support/repository/ToolRun.ts';

const TOOL = 'scheduled/BenchmarkRuns.ts';
const ALARM = /^::warning::.*regress/im;
const SETUP = /setup/i;
const MEMORY = /memory/i;
const fixture = (name: string): string => join(FIXTURES, 'tooling', 'benchmark', name);

const summaryFolders: string[] = [];
after(() => { for (const folder of summaryFolders) rmSync(folder, { recursive: true, force: true }); });

type BenchmarkRun = ToolRun & { readonly summary: string };

// Compares a recorded sample file with the fixture baseline (or the repository's own), with a job
// summary file to write to, as GitHub Actions gives one.
function compare(samples: string, baseline: string | null = fixture('baseline.json')): BenchmarkRun {
  const folder = mkdtempSync(join(tmpdir(), 'revisum-benchmark-summary-'));
  summaryFolders.push(folder);
  const summaryFile = join(folder, 'summary.md');
  const words = ['--samples', fixture(samples), ...(baseline === null ? [] : ['--baseline', baseline])];
  const ran = runTool(TOOL, words, { cwd: REPOSITORY_ROOT, environment: { ...process.env, GITHUB_STEP_SUMMARY: summaryFile } });
  return { ...ran, summary: existsSync(summaryFile) ? readFileSync(summaryFile, 'utf8') : '' };
}

const alarmLines = (run: BenchmarkRun): string[] => run.output.split(/\r?\n/).filter((line) => ALARM.test(line));

// ---- The comparison -------------------------------------------------------------------------------

test('medians within 30% of the Linux baseline raise no alarm, even with one slow outlier run', () => {
  // Setup's median is 1200 ms against 1000 (+20%); its mean, pulled up by one 60 s run, is over 4 s.
  const run = compare('within-tolerance.json');
  assert.equal(run.status, 0, describeRun(run));
  assert.deepEqual(alarmLines(run), [], describeRun(run));
  assert.match(run.output, /\b1200\b/, 'the setup median is reported');
  assert.match(run.output, /\b440\b/, 'the peak memory median is reported');
});

test('a setup median 40% over the baseline raises a non-blocking alarm naming setup time, and the tool still exits 0', () => {
  const run = compare('setup-regression.json');
  assert.equal(run.status, 0, describeRun(run));
  const alarms = alarmLines(run);
  assert.equal(alarms.length, 1, describeRun(run));
  assert.match(alarms[0] ?? '', SETUP);
  assert.match(run.summary, /regress/i, 'the job summary has a line for the alarm');
  assert.match(run.summary, SETUP);
});

test('a peak memory median 40% over the baseline raises a non-blocking alarm naming memory, and the tool still exits 0', () => {
  const run = compare('memory-regression.json');
  assert.equal(run.status, 0, describeRun(run));
  const alarms = alarmLines(run);
  assert.equal(alarms.length, 1, describeRun(run));
  assert.match(alarms[0] ?? '', MEMORY);
  assert.match(run.summary, MEMORY);
});

test('medians exactly 30% over the baseline are not over the tolerance, so they raise no alarm', () => {
  const run = compare('at-tolerance.json');
  assert.equal(run.status, 0, describeRun(run));
  assert.deepEqual(alarmLines(run), [], describeRun(run));
});

test('faster runs and lower memory raise no alarm', () => {
  const run = compare('faster.json');
  assert.equal(run.status, 0, describeRun(run));
  assert.deepEqual(alarmLines(run), [], describeRun(run));
});

test('arm64 results are recorded with their medians and no comparison, pass or fail', () => {
  // Five times the Linux baseline: any comparison would alarm.
  const run = compare('arm64.json');
  assert.equal(run.status, 0, describeRun(run));
  assert.deepEqual(alarmLines(run), [], describeRun(run));
  assert.match(run.output, /\b5000\b/);
  assert.match(run.output, /\b2000\b/);
  assert.doesNotMatch(`${run.output}\n${run.summary}`, /regress/i, describeRun(run));
});

test('fewer than 20 runs are not compared, and the tool says it needs 20', () => {
  // These 19 runs are 40% over the baseline on both medians.
  const run = compare('nineteen-runs.json');
  assert.equal(run.status, 0, describeRun(run));
  assert.deepEqual(alarmLines(run), [], describeRun(run));
  assert.match(run.output, /\b20\b/, describeRun(run));
});

test('samples that do not decode are named, compared with nothing, and still never fail the job', () => {
  const run = compare('invalid-missing-memory.json');
  assert.equal(run.status, 0, describeRun(run));
  assert.deepEqual(alarmLines(run), [], describeRun(run));
  assert.match(run.output, /peakMemoryMegabytes/, describeRun(run));
});

test('the repository\'s own Linux baseline decodes and is the default', () => {
  const path = join(REPOSITORY_ROOT, 'docs', 'decisions', 'benchmark-baseline.json');
  assert.ok(existsSync(path), 'docs/decisions/benchmark-baseline.json exists');
  const baseline: unknown = JSON.parse(readFileSync(path, 'utf8'));
  assert.ok(typeof baseline === 'object' && baseline !== null, 'the baseline is an object');
  const linux: unknown = Reflect.get(baseline, 'linux-x64');
  assert.ok(typeof linux === 'object' && linux !== null, 'the baseline has a linux-x64 entry');
  for (const field of ['setupMedianMilliseconds', 'peakMemoryMegabytes']) {
    const value: unknown = Reflect.get(linux, field);
    assert.ok(typeof value === 'number' && value > 0, `${field} is a positive number`);
  }
  // Compared with the default baseline, the output reports a comparison: whatever it finds, it exits 0.
  const run = compare('within-tolerance.json', null);
  assert.equal(run.status, 0, describeRun(run));
  assert.doesNotMatch(run.output, /cannot read|does not decode|no baseline/i, describeRun(run));
});

// ---- Where it runs ------------------------------------------------------------------------------

const workflowsFolder = join(REPOSITORY_ROOT, '.github', 'workflows');
const workflows = (): { readonly name: string; readonly text: string }[] =>
  readdirSync(workflowsFolder).filter((name) => /\.ya?ml$/.test(name)).map((name) => ({ name, text: readFileSync(join(workflowsFolder, name), 'utf8') }));
const runsBenchmark = (text: string): boolean => text.includes(`tools/${TOOL}`) || /npm run benchmark\b/.test(text);
// The text of the workflow's `on:` block.
const triggersOf = (text: string): string => /^on:\s*\n((?:[ \t]+.*\n|\s*\n)*)/m.exec(text)?.[1] ?? '';

test('the benchmark runs in its own workflow, weekly and on manual dispatch, never on a push or a pull request', () => {
  const benchmark = workflows().filter((workflow) => runsBenchmark(workflow.text));
  assert.equal(benchmark.length, 1, `workflows running the benchmark: ${benchmark.map((workflow) => workflow.name).join(', ')}`);
  const workflow = benchmark[0] ?? assert.fail('no benchmark workflow');
  const triggers = triggersOf(workflow.text);
  assert.match(triggers, /^\s*schedule:\s*$/m, `${workflow.name} has no schedule`);
  assert.match(triggers, /^\s*workflow_dispatch:/m, `${workflow.name} cannot be started by hand`);
  assert.doesNotMatch(triggers, /^\s*(push|pull_request|pull_request_target|merge_group):/m, `${workflow.name} runs on code changes`);
  const cron = /^\s*-\s*cron:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(triggers)?.[1] ?? '';
  const fields = cron.trim().split(/\s+/);
  assert.equal(fields.length, 5, `cron "${cron}"`);
  assert.deepEqual([fields[2], fields[3]], ['*', '*'], `cron "${cron}" runs on a day of the week`);
  assert.match(fields[4] ?? '', /^[0-6]$|^(SUN|MON|TUE|WED|THU|FRI|SAT)$/i, `cron "${cron}" runs once a week`);
});

test('the benchmark workflow runs in the same pinned image as the ci workflow', () => {
  const all = workflows();
  const ci = all.find((workflow) => workflow.name === 'ci.yml') ?? assert.fail('no ci workflow');
  const pinned = /[\w./-]+:[\w.-]+@sha256:[0-9a-f]{64}/.exec(ci.text)?.[0] ?? assert.fail('the ci workflow names no pinned image');
  const benchmark = all.find((workflow) => runsBenchmark(workflow.text)) ?? assert.fail('no benchmark workflow');
  assert.ok(benchmark.text.includes(pinned), `${benchmark.name} does not run in ${pinned}`);
});

test('the benchmark is outside check, the gates and the ci workflow', () => {
  const manifest: unknown = JSON.parse(readFileSync(join(REPOSITORY_ROOT, 'package.json'), 'utf8'));
  const scripts: unknown = typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'scripts') : undefined;
  assert.ok(typeof scripts === 'object' && scripts !== null, 'package.json has scripts');
  const script = (name: string): string => String(Reflect.get(scripts, name) ?? '');
  assert.match(script('benchmark'), new RegExp(`tools/${TOOL.replace('.', '\\.')}`), 'npm run benchmark runs the tool');
  for (const name of ['check', 'check:tests', 'gates', 'test', 'proofs', 'replay']) {
    assert.doesNotMatch(script(name), /benchmark/, `npm run ${name} runs the benchmark`);
  }
  const ci = workflows().find((workflow) => workflow.name === 'ci.yml') ?? assert.fail('no ci workflow');
  assert.equal(runsBenchmark(ci.text), false, 'the ci workflow runs the benchmark');
  assert.doesNotMatch(readFileSync(join(REPOSITORY_ROOT, 'tools', 'metrics', 'GuaranteeMap.ts'), 'utf8'), /benchmark/i, 'the guarantee map names the benchmark');
});
