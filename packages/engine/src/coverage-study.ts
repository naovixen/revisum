// The coverage study: for each sampled test intent from public test suites, whether the plan
// language can express it and why, and the share it can express. A claim of "expressible" is
// believed only when the intent's plan passes the plan parser, so the share cannot be talked up.
// See docs/specs/SPEC-01-plan-language-and-parser.md.
import { failure, success, type Plan, type Result, type SafeText } from '@revisum/contracts';
import { INVALID, allValid, readList, readOneOf, readRecord, readText, type Issues, type Parsed, type PlanError } from './plan/plan-decoders.ts';

export const COVERAGE_VERDICTS = ['expressible', 'not-expressible'] as const;
export type CoverageVerdict = (typeof COVERAGE_VERDICTS)[number];

export type CoverageIntent = {
  readonly suite: SafeText;
  readonly sourceUrl: SafeText;
  readonly testName: SafeText;
  readonly verdict: CoverageVerdict;
  readonly reason: string;
};
export type CoverageReport = { readonly intents: readonly CoverageIntent[]; readonly expressibleShare: number };

const INTENT_FIELDS = ['suite', 'sourceUrl', 'testName', 'verdict', 'reason', 'plan'] as const;
const MAXIMUM_INTENTS = 2000;
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
  const fields = readRecord(input, path, issues, INTENT_FIELDS, INTENT_FIELDS.filter((field) => field !== 'plan'));
  if (fields === INVALID) return INVALID;
  const parts = [
    readText(fields['suite'], `${path}.suite`, issues, MAXIMUM_TEXT_LENGTH),
    readSourceUrl(fields['sourceUrl'], `${path}.sourceUrl`, issues),
    readText(fields['testName'], `${path}.testName`, issues, MAXIMUM_TEXT_LENGTH),
    readOneOf(fields['verdict'], `${path}.verdict`, issues, COVERAGE_VERDICTS),
    readText(fields['reason'], `${path}.reason`, issues, MAXIMUM_TEXT_LENGTH),
  ] as const;
  if (!allValid(parts)) return INVALID;
  const [suite, sourceUrl, testName, verdict, reason] = parts;
  // An expressible intent must show its plan, or the verdict could not be checked.
  if (verdict === 'expressible' && !Object.hasOwn(fields, 'plan')) { issues.push({ code: 'missing_field', path: `${path}.plan` }); return INVALID; }
  return { suite, sourceUrl, testName, verdict, reason, plan: fields['plan'] };
}

// The reason recorded when a plan said to be expressible is rejected: the parser's codes and
// paths, which never repeat a value from the plan.
const overturnedReason = (errors: readonly PlanError[]): string =>
  `Marked expressible, but its plan was rejected: ${errors.slice(0, 5).map((error) => `${error.code} at ${error.path}`).join('; ')}${errors.length > 5 ? '; and more' : ''}`;

// Decodes a study file and checks every intent marked expressible with `parsePlan`.
export function assessCoverage(
  input: unknown,
  parsePlan: (input: unknown) => Result<Plan, readonly PlanError[]>,
): Result<CoverageReport, readonly PlanError[]> {
  const issues: Issues = [];
  const fields = readRecord(input, '$', issues, ['intents']);
  if (fields === INVALID) return failure(issues);
  const raw = readList(fields['intents'], '$.intents', issues, MAXIMUM_INTENTS);
  if (raw === INVALID) return failure(issues);
  const recorded = raw.map((intent, index) => readIntent(intent, `$.intents[${index}]`, issues));
  if (!allValid(recorded)) return failure(issues);
  const intents = recorded.map(({ plan, ...intent }): CoverageIntent => {
    if (intent.verdict !== 'expressible') return intent;
    const parsed = parsePlan(plan);
    return parsed.ok ? intent : { ...intent, verdict: 'not-expressible', reason: overturnedReason(parsed.error) };
  });
  const expressible = intents.filter((intent) => intent.verdict === 'expressible').length;
  return success({ intents, expressibleShare: expressible / intents.length });
}
