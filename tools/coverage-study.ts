// Runs the coverage study: reads the sampled test intents in docs/coverage-study/intents.json,
// checks each with the engine's assessCoverage (an intent marked expressible counts only if its
// plan parses, with its suite's project when the file gives one) and writes
// docs/coverage-study/report.md, with the expressible share of each sample and of both: the
// closed-language share and, beside it, the "1.3 with unsafe features" share. The kill criterion
// is decided by the closed share alone. It is run by hand when the study changes, not by
// `npm run check`.
//   node tools/coverage-study.ts
// See docs/specs/SPEC-01-plan-language-and-parser.md, docs/specs/SPEC-30-plan-values-positions-and-keys.md
// and docs/specs/SPEC-36-unsafe-plan-features.md.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEngineFunction } from './engine-loader.ts';

const STUDY_PATH = 'docs/coverage-study/intents.json';
const REPORT_PATH = 'docs/coverage-study/report.md';
// The MVP plan stops the plan language if it expresses less than this share of sampled intents.
const KILL_THRESHOLD = 0.7;

// The stand-in project for suites the study file gives no project of their own: one Chromium target, and paths
// relative to the app under test. A study plan names the target "playwright-chromium". Plans sign
// in with the test account's password as a secret reference, since a plan never holds a secret.
const STUDY_PROJECT = {
  origins: ['http://127.0.0.1:4173'],
  secretNames: ['TEST_ACCOUNT_PASSWORD'],
  matrix: [{
    id: 'playwright-chromium', adapter: 'playwright', engine: 'chromium', device: 'desktop-1280',
    locale: 'en-GB', timezone: 'UTC', colorScheme: 'light', reducedMotion: 'reduce',
  }],
};

type ReportedIntent = {
  readonly suite: string; readonly sample: string; readonly sourceUrl: string; readonly testName: string; readonly verdict: string;
  readonly reason: string;
  // The unsafe features its plan uses; empty for a closed plan.
  readonly unsafeFeatures: readonly string[];
};
// Each sample's share; null for a sample with no intents.
type SampleShares = { readonly original: number | null; readonly fresh: number | null };
// One share, overall and per sample.
type Share = { readonly overall: number; readonly bySample: SampleShares };
type Report = {
  readonly intents: readonly ReportedIntent[];
  // The closed-language share, and the "1.3 with unsafe features" share.
  readonly closed: Share;
  readonly withUnsafeFeatures: Share;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textField = (record: Readonly<Record<string, unknown>>, name: string): string => String(record[name] ?? '');

const shareOrNull = (value: unknown): number | null => {
  if (value === null || typeof value === 'number') return value;
  throw new Error('assessCoverage returned an unexpected share');
};

// One share from the engine's report: its overall value and its per-sample record.
function readShare(value: Readonly<Record<string, unknown>>, overallField: string, bySampleField: string): Share {
  const overall = value[overallField];
  const bySample = value[bySampleField];
  if (typeof overall !== 'number' || !isRecord(bySample)) throw new Error('assessCoverage returned an unexpected shape');
  return { overall, bySample: { original: shareOrNull(bySample['original']), fresh: shareOrNull(bySample['fresh']) } };
}

// Reads the engine's report back into plain fields, refusing anything that is not its shape.
function readReport(value: unknown): Report {
  if (!isRecord(value) || !Array.isArray(value['intents'])) throw new Error('assessCoverage returned an unexpected shape');
  const intents = value['intents'].map((intent): ReportedIntent => {
    if (!isRecord(intent)) throw new Error('assessCoverage returned an unexpected intent');
    const features = intent['unsafeFeatures'] ?? [];
    if (!Array.isArray(features)) throw new Error('assessCoverage returned an unexpected intent');
    return {
      suite: textField(intent, 'suite'), sample: textField(intent, 'sample'), sourceUrl: textField(intent, 'sourceUrl'),
      testName: textField(intent, 'testName'),
      verdict: textField(intent, 'verdict'), reason: textField(intent, 'reason'), unsafeFeatures: features.map(String),
    };
  });
  return {
    intents,
    closed: readShare(value, 'expressibleShare', 'expressibleShareBySample'),
    withUnsafeFeatures: readShare(value, 'shareWithUnsafeFeatures', 'shareWithUnsafeFeaturesBySample'),
  };
}

// A URL safe inside a Markdown link: brackets and spaces would end the link early.
const linkTarget = (url: string): string =>
  url.replace(/[()\s]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

// Text for a Markdown table cell: pipes and line breaks would break the row.
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

const percentOf = (share: number): string => `${(share * 100).toFixed(1)}%`;

// The name the report gives the second share.
const SHARE_WITH_UNSAFE_FEATURES = '1.3 with unsafe features';

// One line per sample that has intents, with both shares side by side.
function sampleLines(intents: readonly ReportedIntent[], closed: SampleShares, withUnsafeFeatures: SampleShares): string[] {
  return (['original', 'fresh'] as const).flatMap((sample) => {
    const closedShare = closed[sample];
    const unsafeShare = withUnsafeFeatures[sample];
    const count = intents.filter((intent) => intent.sample === sample).length;
    return closedShare === null || unsafeShare === null
      ? []
      : [`- The ${sample} sample: ${count} intents, ${percentOf(closedShare)} expressible in the closed language, ${percentOf(unsafeShare)} in ${SHARE_WITH_UNSAFE_FEATURES}.`];
  });
}

function reportMarkdown({ intents, closed, withUnsafeFeatures }: Report): string {
  const suites = new Set(intents.map((intent) => intent.suite)).size;
  const expressible = intents.filter((intent) => intent.verdict === 'expressible');
  const closedCount = expressible.filter((intent) => intent.unsafeFeatures.length === 0).length;
  // The kill criterion counts intents expressible without an escape hatch: the closed share alone.
  const killCriterionMet = closed.overall >= KILL_THRESHOLD;
  return [
    '# Coverage study',
    '',
    '## In short',
    '',
    `- ${intents.length} test intents from ${suites} suites; ${closedCount} expressible in the closed plan language (${percentOf(closed.overall)}).`,
    `- ${SHARE_WITH_UNSAFE_FEATURES}, where each suite's project enables them: ${expressible.length} expressible (${percentOf(withUnsafeFeatures.overall)}).`,
    ...sampleLines(intents, closed.bySample, withUnsafeFeatures.bySample),
    `- The MVP plan's kill criterion is ${KILL_THRESHOLD * 100}% expressible in the closed language: ${killCriterionMet ? 'met' : 'not met'}.`,
    '- An intent marked expressible counts only when its plan passes the plan parser under its suite\'s project. A plan using an unsafe feature counts only toward the second share.',
    `- Generated by \`node tools/coverage-study.ts\` from \`${STUDY_PATH}\`. Do not edit by hand.`,
    '',
    '## Intents',
    '',
    '| Suite | Sample | Test | Verdict | Unsafe features | Reason |',
    '|---|---|---|---|---|---|',
    ...intents.map((intent) => `| ${cell(intent.suite)} | ${intent.sample} | [${cell(intent.testName)}](${linkTarget(intent.sourceUrl)}) | ${intent.verdict} | ${cell(intent.unsafeFeatures.join(', '))} | ${cell(intent.reason)} |`),
    '',
  ].join('\n');
}

async function main(root: string): Promise<number> {
  const studyFile = join(root, STUDY_PATH);
  if (!existsSync(studyFile)) { console.error(`coverage study: ${STUDY_PATH} is missing`); return 1; }
  const parseProject = await loadEngineFunction(root, 'parseProject');
  const planParser = await loadEngineFunction(root, 'planParser');
  const assessCoverage = await loadEngineFunction(root, 'assessCoverage');
  const project = parseProject(STUDY_PROJECT);
  if (!isRecord(project) || project['ok'] !== true) throw new Error('the study project was rejected');
  const outcome = assessCoverage(JSON.parse(readFileSync(studyFile, 'utf8')), planParser(project['value']));
  if (!isRecord(outcome) || outcome['ok'] !== true) {
    console.error(`coverage study: ${STUDY_PATH} was rejected: ${JSON.stringify(isRecord(outcome) ? outcome['error'] : outcome)}`);
    return 1;
  }
  const report = readReport(outcome['value']);
  writeFileSync(join(root, REPORT_PATH), reportMarkdown(report));
  console.log(`coverage study: wrote ${REPORT_PATH}; ${percentOf(report.closed.overall)} expressible in the closed language, ${percentOf(report.withUnsafeFeatures.overall)} in ${SHARE_WITH_UNSAFE_FEATURES}`);
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.cwd());
