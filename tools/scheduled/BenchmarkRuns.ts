// The performance benchmark: a trend alarm, never a gate.
//   node tools/scheduled/BenchmarkRuns.ts [--baseline <file>]
//     runs the sign-up plan 20 times on the CDP driver's headless shell (cli's benchmarkRuns): setup
//     time from calling run to the first step.start, peak memory the highest combined resident
//     memory of Node and Chromium, sampled from /proc every 100 ms. Then compares as below.
//   node tools/scheduled/BenchmarkRuns.ts --samples <file> [--baseline <file>]
//     compares recorded runs instead: { "platform": "linux-x64", "runs": [{ "setupMilliseconds",
//     "peakMemoryMegabytes" }] }.
// On linux-x64 the medians of 20 runs are compared with the stored baseline ({ "linux-x64": {
// "setupMedianMilliseconds", "peakMemoryMegabytes" } }, by default
// docs/decisions/benchmark-baseline.json). A median more than 30% over its baseline prints a
// "::warning::" line naming the regression and adds a line to the job summary
// ($GITHUB_STEP_SUMMARY). On arm64, or any platform the baseline has no entry for, the medians are
// recorded with no comparison. Fewer than 20 runs are not compared. Whatever it finds, even samples
// that do not decode, the tool exits 0: it runs in its own weekly workflow and never fails a job.
// The stored baseline's first values are provisional; replace them with the medians of the first
// weekly run in the pinned image.
import { appendFileSync, readFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BASELINE_FILE = 'docs/decisions/benchmark-baseline.json';
// What the budget fixes: 20 runs, and a median more than 30% over the baseline raises the alarm.
export const BENCHMARK_RUNS = 20;
export const TOLERANCE_PERCENT = 30;
// The only platform with a baseline to compare against.
const COMPARED_PLATFORM = 'linux-x64';

export type Sample = { readonly setupMilliseconds: number; readonly peakMemoryMegabytes: number };
export type Samples = { readonly platform: string; readonly runs: readonly Sample[] };
export type Baseline = { readonly setupMedianMilliseconds: number; readonly peakMemoryMegabytes: number };

type Decoded<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly faults: readonly string[] };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isMeasure = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

// Decodes a samples file. Every fault is named by its run and field; nothing is guessed or dropped.
export function decodeSamples(input: unknown): Decoded<Samples> {
  if (!isRecord(input)) {return { ok: false, faults: ['the samples must be a JSON object with platform and runs'] };}
  const faults: string[] = [];
  for (const key of Object.keys(input)) {if (key !== 'platform' && key !== 'runs') {faults.push(`unknown field ${key}`);}}
  const platformName = input['platform'];
  if (typeof platformName !== 'string' || platformName === '') {faults.push('platform is missing or not text');}
  const runs = input['runs'];
  if (!Array.isArray(runs)) {return { ok: false, faults: [...faults, 'runs is missing or not a list'] };}
  const decoded: Sample[] = [];
  runs.forEach((run: unknown, index) => {
    const where = `run ${index + 1}`;
    if (!isRecord(run)) { faults.push(`${where} is not an object`); return; }
    for (const key of Object.keys(run)) {if (key !== 'setupMilliseconds' && key !== 'peakMemoryMegabytes') {faults.push(`${where}: unknown field ${key}`);}}
    const { setupMilliseconds, peakMemoryMegabytes } = run;
    if (!isMeasure(setupMilliseconds)) {faults.push(`${where}: setupMilliseconds is missing or not a number of at least 0`);}
    if (!isMeasure(peakMemoryMegabytes)) {faults.push(`${where}: peakMemoryMegabytes is missing or not a number of at least 0`);}
    if (isMeasure(setupMilliseconds) && isMeasure(peakMemoryMegabytes)) {decoded.push({ setupMilliseconds, peakMemoryMegabytes });}
  });
  if (faults.length > 0 || typeof platformName !== 'string') {return { ok: false, faults };}
  return { ok: true, value: { platform: platformName, runs: decoded } };
}

// Decodes the baseline file's entry for one platform; null when the file has none for it.
export function decodeBaseline(input: unknown, platformName: string): Decoded<Baseline | null> {
  if (!isRecord(input)) {return { ok: false, faults: ['the baseline must be a JSON object keyed by platform'] };}
  const entry = input[platformName];
  if (entry === undefined) {return { ok: true, value: null };}
  if (!isRecord(entry)) {return { ok: false, faults: [`the ${platformName} baseline is not an object`] };}
  const { setupMedianMilliseconds, peakMemoryMegabytes } = entry;
  const faults: string[] = [];
  if (!isMeasure(setupMedianMilliseconds) || setupMedianMilliseconds === 0) {faults.push(`${platformName}: setupMedianMilliseconds is not a positive number`);}
  if (!isMeasure(peakMemoryMegabytes) || peakMemoryMegabytes === 0) {faults.push(`${platformName}: peakMemoryMegabytes is not a positive number`);}
  if (!isMeasure(setupMedianMilliseconds) || !isMeasure(peakMemoryMegabytes) || faults.length > 0) {return { ok: false, faults };}
  return { ok: true, value: { setupMedianMilliseconds, peakMemoryMegabytes } };
}

// The middle value, or the mean of the two middle values; a median ignores a single slow outlier.
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] ?? 0 : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

const shown = (value: number): string => String(Math.round(value * 10) / 10);
const percentOver = (value: number, baseline: number): number => ((value - baseline) / baseline) * 100;
// Over the tolerance, compared in whole numbers so exactly 30% over is not over.
const overTolerance = (value: number, baseline: number): boolean => value * 100 > baseline * (100 + TOLERANCE_PERCENT);

export type Report = { readonly lines: readonly string[]; readonly alarms: readonly string[]; readonly summary: readonly string[] };

// What the benchmark reports for the samples, given the stored baseline's entry for their platform.
export function compare(samples: Samples, baseline: Baseline | null): Report {
  const setup = median(samples.runs.map((run) => run.setupMilliseconds));
  const memory = median(samples.runs.map((run) => run.peakMemoryMegabytes));
  const measured = [
    `Benchmark on ${samples.platform}: ${samples.runs.length} runs.`,
    `  setup time median: ${shown(setup)} ms`,
    `  peak memory median: ${shown(memory)} MB`,
  ];
  const recorded = (why: string): Report => ({
    lines: [...measured, why], alarms: [], summary: [`Benchmark on ${samples.platform}: setup time median ${shown(setup)} ms, peak memory median ${shown(memory)} MB. ${why}`],
  });
  if (samples.platform !== COMPARED_PLATFORM) {return recorded(`Recorded with no comparison: only ${COMPARED_PLATFORM} is compared.`);}
  if (samples.runs.length !== BENCHMARK_RUNS) {return recorded(`Not compared: a comparison needs exactly ${BENCHMARK_RUNS} runs, and there are ${samples.runs.length}.`);}
  if (baseline === null) {return recorded(`Recorded with no comparison: the baseline file has no ${COMPARED_PLATFORM} entry.`);}
  const measures = [
    { name: 'setup time', value: setup, baseline: baseline.setupMedianMilliseconds, unit: 'ms' },
    { name: 'peak memory', value: memory, baseline: baseline.peakMemoryMegabytes, unit: 'MB' },
  ];
  const lines = [
    `Benchmark on ${samples.platform}: ${samples.runs.length} runs, compared with the stored baseline (tolerance ${TOLERANCE_PERCENT}%).`,
    ...measures.map((measure) => `  ${measure.name} median: ${shown(measure.value)} ${measure.unit} (baseline ${shown(measure.baseline)} ${measure.unit}, ${percentOver(measure.value, measure.baseline) >= 0 ? '+' : ''}${shown(percentOver(measure.value, measure.baseline))}%)`),
  ];
  const regressions = measures.filter((measure) => overTolerance(measure.value, measure.baseline)).map((measure) =>
    `${measure.name} regressed: median ${shown(measure.value)} ${measure.unit} is ${shown(percentOver(measure.value, measure.baseline))}% over the baseline of ${shown(measure.baseline)} ${measure.unit} (tolerance ${TOLERANCE_PERCENT}%)`);
  return {
    lines,
    alarms: regressions.map((regression) => `::warning::Benchmark trend alarm, not a gate: ${regression}`),
    summary: regressions.length === 0
      ? [`Benchmark on ${samples.platform}: setup time median ${shown(setup)} ms, peak memory median ${shown(memory)} MB, within ${TOLERANCE_PERCENT}% of the baseline.`]
      : regressions.map((regression) => `- Benchmark ${regression}.`),
  };
}

// ---- The command -------------------------------------------------------------------------------

function optionValue(words: readonly string[], name: string): string | undefined {
  const index = words.indexOf(name);
  return index === -1 ? undefined : words[index + 1];
}

function readJson(path: string): Decoded<unknown> {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    return { ok: false, faults: [`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

// The headless shell's executable, as tools/browsers/ChromeForTestingBuild.ts installs it; CHROME_HEADLESS_SHELL_PATH overrides it.
async function headlessShellPath(root: string): Promise<string> {
  const override = process.env['CHROME_HEADLESS_SHELL_PATH'];
  if (override !== undefined) {return override;}
  const { CHROME_FOR_TESTING_BUILD } = await import('../browsers/ChromeForTestingBuild.ts');
  const cache = join(root, '.browsers', 'chrome-headless-shell');
  return platform() === 'win32'
    ? join(cache, `win64-${CHROME_FOR_TESTING_BUILD}`, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
    : join(cache, `linux-${CHROME_FOR_TESTING_BUILD}`, 'chrome-headless-shell-linux64', 'chrome-headless-shell');
}

// Runs the sign-up plan through cli's benchmarkRuns, loaded at run time: tools compile without the
// packages. Its answer is decoded like any samples file.
async function measuredSamples(root: string): Promise<unknown> {
  const cli: unknown = await import(pathToFileURL(join(root, 'packages', 'cli', 'src', 'index.ts')).href);
  const benchmarkRuns: unknown = isRecord(cli) ? cli['benchmarkRuns'] : undefined;
  if (typeof benchmarkRuns !== 'function') {throw new Error('@revisum/cli does not export benchmarkRuns');}
  return Reflect.apply(benchmarkRuns, undefined, [{ repositoryRoot: root, executablePath: await headlessShellPath(root), runs: BENCHMARK_RUNS }]);
}

async function main(words: readonly string[]): Promise<void> {
  const root = process.cwd();
  const say = (line: string): void => { process.stdout.write(`${line}\n`); };
  const samplesPath = optionValue(words, '--samples');
  let input: unknown;
  if (samplesPath === undefined) {
    try {
      input = await measuredSamples(root);
    } catch (error) {
      say(`The benchmark could not run: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
  } else {
    const read = readJson(samplesPath);
    if (!read.ok) { read.faults.forEach(say); return; }
    input = read.value;
  }
  const samples = decodeSamples(input);
  if (!samples.ok) {
    say('The samples do not decode, so nothing was compared:');
    for (const fault of samples.faults) {say(`  ${fault}`);}
    return;
  }
  const baselinePath = optionValue(words, '--baseline') ?? join(root, BASELINE_FILE);
  const baselineJson = readJson(baselinePath);
  const baseline = baselineJson.ok ? decodeBaseline(baselineJson.value, samples.value.platform) : baselineJson;
  if (!baseline.ok) {
    say(`The baseline ${baselinePath} does not decode, so nothing was compared:`);
    for (const fault of baseline.faults) {say(`  ${fault}`);}
  }
  const report = compare(samples.value, baseline.ok ? baseline.value : null);
  for (const line of [...report.lines, ...report.alarms]) {say(line);}
  const summaryFile = process.env['GITHUB_STEP_SUMMARY'];
  if (summaryFile !== undefined && summaryFile !== '') {appendFileSync(summaryFile, `${report.summary.join('\n')}\n`);}
}

if (import.meta.main) {
  // Never a gate: whatever happened, the job goes on.
  await main(process.argv.slice(2)).catch((error: unknown) => {
    process.stdout.write(`The benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`);
  });
  process.exitCode = 0;
}
