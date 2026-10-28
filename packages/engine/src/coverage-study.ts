// The coverage study: for each sampled test intent from public test suites, whether the plan
// language can express it and why, and the share it can express. A claim of "expressible" is
// believed only when the intent's plan passes the plan parser, so the share cannot be talked up.
// A suite may give its own project, with the declarations its plans rely on (secret names,
// email domains, test-id attributes); its intents' plans are parsed with that project. Each
// intent belongs to a sample: the original one, or the fresh one drawn after the grammar froze.
// See docs/specs/SPEC-01-plan-language-and-parser.md and docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import { failure, success, type Plan, type Result, type SafeText } from '@revisum/contracts';
import { INVALID, allValid, peekRecord, readList, readOneOf, readRecord, readText, type Issues, type Parsed, type PlanError } from './plan/plan-decoders.ts';
import { planParser } from './plan/plan-parser.ts';
import { parseProject } from './project/project-parser.ts';

export const COVERAGE_VERDICTS = ['expressible', 'not-expressible'] as const;
export type CoverageVerdict = (typeof COVERAGE_VERDICTS)[number];
// The sample an intent was drawn in. An intent that names none belongs to the original sample.
export const COVERAGE_SAMPLES = ['original', 'fresh'] as const;
export type CoverageSample = (typeof COVERAGE_SAMPLES)[number];

export type CoverageIntent = {
  readonly suite: SafeText;
  readonly sample: CoverageSample;
  readonly sourceUrl: SafeText;
  readonly testName: SafeText;
  readonly verdict: CoverageVerdict;
  readonly reason: string;
};
export type CoverageReport = {
  readonly intents: readonly CoverageIntent[];
  // Of every intent, both samples together.
  readonly expressibleShare: number;
  // Of each sample on its own; null for a sample with no intents.
  readonly expressibleShareBySample: { readonly [Sample in CoverageSample]: number | null };
};

type ParsePlan = (input: unknown) => Result<Plan, readonly PlanError[]>;

const INTENT_FIELDS = ['suite', 'sample', 'sourceUrl', 'testName', 'verdict', 'reason', 'plan'] as const;
const OPTIONAL_INTENT_FIELDS: readonly string[] = ['sample', 'plan'];
const MAXIMUM_INTENTS = 2000;
const MAXIMUM_SUITES = 500;
const MAXIMUM_TEXT_LENGTH = 500;

// An intent as written in the study file, with its plan still unparsed.
type RecordedIntent = Omit<CoverageIntent, 'reason'> & { readonly reason: SafeText; readonly plan: unknown };

function readSourceUrl(input: unknown, path: string, issues: Issues): Parsed<SafeText> {
  const text = readText(input, path, issues, 2048);
  if (text === INVALID) return INVALID;
  let url: URL;
  try { url = new URL(text); } catch { issues.push({ code: 'invalid_url', path }); return INVALID; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') { issues.push({ code: 'scheme_not_allowed', path }); return INVALID; }
  return text;
}

function readIntent(input: unknown, path: string, issues: Issues): Parsed<RecordedIntent> {
  const fields = readRecord(input, path, issues, INTENT_FIELDS, INTENT_FIELDS.filter((field) => !OPTIONAL_INTENT_FIELDS.includes(field)));
  if (fields === INVALID) return INVALID;
  const parts = [
    readText(fields['suite'], `${path}.suite`, issues, MAXIMUM_TEXT_LENGTH),
    Object.hasOwn(fields, 'sample') ? readOneOf(fields['sample'], `${path}.sample`, issues, COVERAGE_SAMPLES) : 'original',
    readSourceUrl(fields['sourceUrl'], `${path}.sourceUrl`, issues),
    readText(fields['testName'], `${path}.testName`, issues, MAXIMUM_TEXT_LENGTH),
    readOneOf(fields['verdict'], `${path}.verdict`, issues, COVERAGE_VERDICTS),
    readText(fields['reason'], `${path}.reason`, issues, MAXIMUM_TEXT_LENGTH),
  ] as const;
  if (!allValid(parts)) return INVALID;
  const [suite, sample, sourceUrl, testName, verdict, reason] = parts;
  // An expressible intent must show its plan, or the verdict could not be checked.
  if (verdict === 'expressible' && !Object.hasOwn(fields, 'plan')) { issues.push({ code: 'missing_field', path: `${path}.plan` }); return INVALID; }
  return { suite, sample, sourceUrl, testName, verdict, reason, plan: fields['plan'] };
}

// Each suite's plan parser, built from the project the study file gives it. A project the
// project parser refuses rejects the whole study file, with its errors placed under that project.
function readSuites(input: unknown, issues: Issues): Parsed<ReadonlyMap<string, ParsePlan>> {
  const parsers = new Map<string, ParsePlan>();
  if (input === undefined) return parsers;
  const suites = peekRecord(input, '$.suites', issues);
  if (suites === INVALID) return INVALID;
  if (Object.keys(suites).length > MAXIMUM_SUITES) { issues.push({ code: 'too_large', path: '$.suites' }); return INVALID; }
  const before = issues.length;
  for (const [name, suite] of Object.entries(suites)) {
    const path = `$.suites.${name}`;
    const fields = readRecord(suite, path, issues, ['project']);
    if (fields === INVALID) continue;
    const project = parseProject(fields['project']);
    if (!project.ok) {
      // A project error's path starts at the project's own root, "$".
      issues.push(...project.error.map((error) => ({ code: error.code, path: `${path}.project${error.path.slice(1)}` })));
      continue;
    }
    parsers.set(name, planParser(project.value));
  }
  return issues.length === before ? parsers : INVALID;
}

// The reason recorded when a plan said to be expressible is rejected: the parser's codes and
// paths, which never repeat a value from the plan.
const overturnedReason = (errors: readonly PlanError[]): string =>
  `Marked expressible, but its plan was rejected: ${errors.slice(0, 5).map((error) => `${error.code} at ${error.path}`).join('; ')}${errors.length > 5 ? '; and more' : ''}`;

const shareOf = (intents: readonly CoverageIntent[]): number | null =>
  intents.length === 0 ? null : intents.filter((intent) => intent.verdict === 'expressible').length / intents.length;

// Decodes a study file and checks every intent marked expressible with its suite's parser, or with
// `parsePlan` when the file gives its suite no project.
export function assessCoverage(input: unknown, parsePlan: ParsePlan): Result<CoverageReport, readonly PlanError[]> {
  const issues: Issues = [];
  const fields = readRecord(input, '$', issues, ['suites', 'intents'], ['intents']);
  if (fields === INVALID) return failure(issues);
  const parsers = readSuites(fields['suites'], issues);
  const raw = readList(fields['intents'], '$.intents', issues, MAXIMUM_INTENTS);
  if (raw === INVALID || parsers === INVALID) return failure(issues);
  const recorded = raw.map((intent, index) => readIntent(intent, `$.intents[${index}]`, issues));
  if (!allValid(recorded)) return failure(issues);
  const intents = recorded.map(({ plan, ...intent }): CoverageIntent => {
    if (intent.verdict !== 'expressible') return intent;
    const parsed = (parsers.get(intent.suite) ?? parsePlan)(plan);
    return parsed.ok ? intent : { ...intent, verdict: 'not-expressible', reason: overturnedReason(parsed.error) };
  });
  return success({
    intents,
    expressibleShare: shareOf(intents) ?? 0,
    expressibleShareBySample: {
      original: shareOf(intents.filter((intent) => intent.sample === 'original')),
      fresh: shareOf(intents.filter((intent) => intent.sample === 'fresh')),
    },
  });
}
