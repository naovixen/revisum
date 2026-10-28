// The trusted project: allowed origins, the "test with" matrix, limits, the secret names and
// fixture files a plan may refer to, and the policy the policy gate applies, written by a person. AI output never reaches this type. The
// person declares every target; the engine never invents one.
import {
  COLOR_SCHEMES, DEVICE_PROFILES, ENGINES, MOTION_PREFERENCES, success, failure,
  type Brand, type DeviceProfileId, type FixtureName, type IrreversiblePatterns, type Locale, type Origin, type Result,
  type SafeText, type SecretName, type Target, type TimeZone,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import {
  INVALID, allValid, peekRecord, readInteger, readList, readOneOf, readRecord, readText, type Issues, type Parsed, type PlanError,
} from '../plan/plan-decoders.ts';
import { LOWERCASE_ID, MAXIMUM_TEST_ID_LENGTH, MAXIMUM_URL_LENGTH } from '../plan/plan-grammar.ts';

const DEVICE_IDS = Object.keys(DEVICE_PROFILES) as DeviceProfileId[];

export type Limits = {
  readonly maximumPlanBytes: number;
  readonly maximumSteps: number;
  readonly maximumTextLength: number;
  readonly stepTimeoutMilliseconds: number;
  // How deeply frame steps may nest: a frame inside a frame has depth 2.
  readonly maximumFrameDepth: number;
};
export const DEFAULT_LIMITS: Limits = {
  maximumPlanBytes: 64 * 1024, maximumSteps: 100, maximumTextLength: 500, stepTimeoutMilliseconds: 5000, maximumFrameDepth: 3,
};
// The limits the plan parser checks before it walks a plan, so an oversized plan costs nothing to reject.
export type PlanLimits = Pick<Limits, 'maximumPlanBytes' | 'maximumSteps' | 'maximumFrameDepth'>;

// What the policy gate allows beyond its defaults, and what it denies beyond its built-in rules.
// See docs/specs/SPEC-03-policy-gate.md.
export type ProjectPolicy = {
  // Words the project adds, per locale, to the engine's irreversible patterns.
  readonly irreversiblePatterns: IrreversiblePatterns;
  // Exact accessible names (compared case-insensitively) the project lets through although they
  // match an irreversible pattern, such as "Delete account" for a team testing its delete feature.
  readonly allowedIrreversibleNames: readonly SafeText[];
  // URL paths that destroy something when visited. A path matches itself and every path below it.
  readonly destructiveUrlPatterns: readonly string[];
  // Test ids of controls with no accessible name that a plan may still act on.
  readonly unnamedControlsAllowedByTestId: readonly SafeText[];
  // Production origins are denied to every plan unless this is true, and then only to approved plans.
  readonly allowProductionForApprovedPlans: boolean;
};
export const DEFAULT_POLICY: ProjectPolicy = {
  irreversiblePatterns: {}, allowedIrreversibleNames: [], destructiveUrlPatterns: [], unnamedControlsAllowedByTestId: [],
  allowProductionForApprovedPlans: false,
};

export type ProjectData = {
  readonly origins: readonly Origin[];
  // Origins that serve real users. A plan with no approval runs only as a proposal, and a proposal
  // never reaches these. Empty unless the project declares some.
  readonly productionOrigins: readonly Origin[];
  readonly matrix: readonly Target[];
  readonly limits: Limits;
  // Secrets a fill step may name. The values live in the secret store, never in the project or a plan.
  readonly secretNames: readonly SecretName[];
  // Files in the project's fixtures folder that an upload step may send, by file name.
  readonly fixtures: readonly FixtureName[];
  readonly policy: ProjectPolicy;
};
export type Project = Brand<ProjectData, 'Project'>;

// An environment-variable style name, such as SIGNUP_PASSWORD.
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
// A plain file name with no folder part, so an upload can never reach outside the fixtures folder.
const FIXTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

// A lowercase id such as a target or adapter id.
export function readId<Name extends string>(input: unknown, path: string, issues: Issues): Parsed<Brand<string, Name>> {
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (!LOWERCASE_ID.test(input)) { issues.push({ code: 'unknown_value', path }); return INVALID; }
  return brand<string, Name>(input);
}

// An http or https origin with no path, written exactly as the URL standard serialises it.
export function readOrigin(input: unknown, path: string, issues: Issues): Parsed<Origin> {
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  let url: URL;
  try { url = new URL(input); } catch { issues.push({ code: 'invalid_url', path }); return INVALID; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') { issues.push({ code: 'scheme_not_allowed', path }); return INVALID; }
  if (url.origin !== input) { issues.push({ code: 'invalid_url', path }); return INVALID; }
  return brand<string, 'Origin'>(input);
}

export function readLocale(input: unknown, path: string, issues: Issues): Parsed<Locale> {
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  try {
    if (Intl.getCanonicalLocales(input)[0] === input) return brand<string, 'Locale'>(input);
  } catch { /* not a language tag: reported below */ }
  issues.push({ code: 'unknown_value', path });
  return INVALID;
}

function readTimeZone(input: unknown, path: string, issues: Issues): Parsed<TimeZone> {
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (input === 'UTC' || Intl.supportedValuesOf('timeZone').includes(input)) return brand<string, 'TimeZone'>(input);
  issues.push({ code: 'unknown_value', path });
  return INVALID;
}

const TARGET_KEYS = ['id', 'adapter', 'engine', 'device', 'locale', 'timezone', 'colorScheme', 'reducedMotion'] as const;

function readTarget(input: unknown, path: string, issues: Issues): Parsed<Target> {
  const fields = readRecord(input, path, issues, TARGET_KEYS);
  if (fields === INVALID) return INVALID;
  const parts = [
    readId<'TargetId'>(fields['id'], `${path}.id`, issues),
    readId<'AdapterId'>(fields['adapter'], `${path}.adapter`, issues),
    readOneOf(fields['engine'], `${path}.engine`, issues, ENGINES),
    readOneOf(fields['device'], `${path}.device`, issues, DEVICE_IDS),
    readLocale(fields['locale'], `${path}.locale`, issues),
    readTimeZone(fields['timezone'], `${path}.timezone`, issues),
    readOneOf(fields['colorScheme'], `${path}.colorScheme`, issues, COLOR_SCHEMES),
    readOneOf(fields['reducedMotion'], `${path}.reducedMotion`, issues, MOTION_PREFERENCES),
  ] as const;
  if (!allValid(parts)) return INVALID;
  const [id, adapter, engine, device, locale, timezone, colorScheme, reducedMotion] = parts;
  return { id, adapter, engine, device, locale, timezone, colorScheme, reducedMotion };
}

const LIMIT_KEYS = ['maximumPlanBytes', 'maximumSteps', 'maximumTextLength', 'stepTimeoutMilliseconds', 'maximumFrameDepth'] as const;

function readLimits(input: unknown, path: string, issues: Issues): Parsed<Limits> {
  if (input === undefined) return DEFAULT_LIMITS;
  const fields = readRecord(input, path, issues, LIMIT_KEYS, []);
  if (fields === INVALID) return INVALID;
  const pick = (key: (typeof LIMIT_KEYS)[number], highest: number): Parsed<number> =>
    fields[key] === undefined ? DEFAULT_LIMITS[key] : readInteger(fields[key], `${path}.${key}`, issues, 1, highest);
  const parts = [
    pick('maximumPlanBytes', 1 << 20), pick('maximumSteps', 1000), pick('maximumTextLength', 4000),
    pick('stepTimeoutMilliseconds', 60_000), pick('maximumFrameDepth', 16),
  ] as const;
  if (!allValid(parts)) return INVALID;
  const [maximumPlanBytes, maximumSteps, maximumTextLength, stepTimeoutMilliseconds, maximumFrameDepth] = parts;
  return { maximumPlanBytes, maximumSteps, maximumTextLength, stepTimeoutMilliseconds, maximumFrameDepth };
}

// An optional list of distinct names that each match `pattern`. Absent means none are declared.
function readNameList<Name extends string>(
  input: unknown, path: string, issues: Issues, pattern: RegExp, extraRule: (name: string) => boolean = () => true,
): Parsed<readonly Brand<string, Name>[]> {
  if (input === undefined) return [];
  const raw = readList(input, path, issues, 256, 0);
  if (raw === INVALID) return INVALID;
  const names = raw.map((value, index): Parsed<Brand<string, Name>> => {
    const at = `${path}[${index}]`;
    if (typeof value !== 'string') { issues.push({ code: 'wrong_type', path: at }); return INVALID; }
    if (!pattern.test(value) || !extraRule(value)) { issues.push({ code: 'unknown_value', path: at }); return INVALID; }
    return brand<string, Name>(value);
  });
  if (!allValid(names)) return INVALID;
  if (new Set(names).size !== names.length) { issues.push({ code: 'duplicate', path }); return INVALID; }
  return names;
}

// An optional list of distinct origins; absent means the project declares none.
function readProductionOrigins(input: unknown, issues: Issues): Parsed<readonly Origin[]> {
  if (input === undefined) return [];
  const raw = readList(input, '$.productionOrigins', issues, 32, 0);
  if (raw === INVALID) return INVALID;
  const origins = raw.map((origin, index) => readOrigin(origin, `$.productionOrigins[${index}]`, issues));
  if (!allValid(origins)) return INVALID;
  if (new Set(origins).size !== origins.length) { issues.push({ code: 'duplicate', path: '$.productionOrigins' }); return INVALID; }
  return origins;
}

const MAXIMUM_PATTERN_LENGTH = 100;
const MAXIMUM_POLICY_LIST = 256;
// Only ever used to read the path of a relative URL.
const PATH_BASE = new URL('https://path.invalid');

// An optional list of distinct, non-blank texts. Absent means none.
function readTextList(input: unknown, path: string, issues: Issues, maximumLength: number, minimumCount = 0): Parsed<readonly SafeText[]> {
  if (input === undefined) return [];
  const raw = readList(input, path, issues, MAXIMUM_POLICY_LIST, minimumCount);
  if (raw === INVALID) return INVALID;
  const texts = raw.map((value, index): Parsed<SafeText> => {
    const at = `${path}[${index}]`;
    const text = readText(value, at, issues, maximumLength);
    // A blank pattern or name would match the spaces in any text, so it is refused outright.
    if (text !== INVALID && text.trim() === '') { issues.push({ code: 'empty', path: at }); return INVALID; }
    return text;
  });
  if (!allValid(texts)) return INVALID;
  if (new Set(texts).size !== texts.length) { issues.push({ code: 'duplicate', path }); return INVALID; }
  return texts;
}

// Per locale, a non-empty list of words. A declared locale with no words would hide the fact
// that nothing is denied there, so an empty list is refused.
function readIrreversiblePatterns(input: unknown, path: string, issues: Issues): Parsed<IrreversiblePatterns> {
  if (input === undefined) return {};
  const fields = peekRecord(input, path, issues);
  if (fields === INVALID) return INVALID;
  const entries = Object.entries(fields).map(([key, value]): Parsed<readonly [Locale, readonly SafeText[]]> => {
    const locale = readLocale(key, `${path}.${key}`, issues);
    const words = readTextList(value, `${path}.${key}`, issues, MAXIMUM_PATTERN_LENGTH, 1);
    return locale === INVALID || words === INVALID ? INVALID : [locale, words];
  });
  if (!allValid(entries)) return INVALID;
  return Object.fromEntries(entries);
}

// URL paths such as /account/delete, with no query or fragment, kept as the URL standard writes them.
function readDestructivePaths(input: unknown, path: string, issues: Issues): Parsed<readonly string[]> {
  if (input === undefined) return [];
  const raw = readList(input, path, issues, MAXIMUM_POLICY_LIST, 0);
  if (raw === INVALID) return INVALID;
  const paths = raw.map((value, index): Parsed<string> => {
    const at = `${path}[${index}]`;
    const text = readText(value, at, issues, MAXIMUM_URL_LENGTH);
    if (text === INVALID) return INVALID;
    let url: URL | undefined;
    try { url = new URL(text, PATH_BASE); } catch { url = undefined; }
    if (url === undefined || !text.startsWith('/') || url.origin !== PATH_BASE.origin || url.search !== '' || url.hash !== '') {
      issues.push({ code: 'invalid_url', path: at });
      return INVALID;
    }
    return url.pathname;
  });
  if (!allValid(paths)) return INVALID;
  if (new Set(paths).size !== paths.length) { issues.push({ code: 'duplicate', path }); return INVALID; }
  return paths;
}

const POLICY_KEYS = [
  'irreversiblePatterns', 'allowedIrreversibleNames', 'destructiveUrlPatterns', 'unnamedControlsAllowedByTestId',
  'allowProductionForApprovedPlans',
] as const;

// Every field is optional; a missing one keeps the strict default.
function readPolicy(input: unknown, path: string, issues: Issues, limits: Parsed<Limits>): Parsed<ProjectPolicy> {
  if (input === undefined) return DEFAULT_POLICY;
  const fields = readRecord(input, path, issues, POLICY_KEYS, []);
  if (fields === INVALID) return INVALID;
  const longestName = limits === INVALID ? DEFAULT_LIMITS.maximumTextLength : limits.maximumTextLength;
  const allowProduction = fields['allowProductionForApprovedPlans'] ?? false;
  if (typeof allowProduction !== 'boolean') issues.push({ code: 'wrong_type', path: `${path}.allowProductionForApprovedPlans` });
  const parts = [
    readIrreversiblePatterns(fields['irreversiblePatterns'], `${path}.irreversiblePatterns`, issues),
    readTextList(fields['allowedIrreversibleNames'], `${path}.allowedIrreversibleNames`, issues, longestName),
    readDestructivePaths(fields['destructiveUrlPatterns'], `${path}.destructiveUrlPatterns`, issues),
    readTextList(fields['unnamedControlsAllowedByTestId'], `${path}.unnamedControlsAllowedByTestId`, issues, MAXIMUM_TEST_ID_LENGTH),
    typeof allowProduction === 'boolean' ? allowProduction : INVALID,
  ] as const;
  if (!allValid(parts)) return INVALID;
  const [irreversiblePatterns, allowedIrreversibleNames, destructiveUrlPatterns, unnamedControlsAllowedByTestId, allowProductionForApprovedPlans] = parts;
  return { irreversiblePatterns, allowedIrreversibleNames, destructiveUrlPatterns, unnamedControlsAllowedByTestId, allowProductionForApprovedPlans };
}

export function parseProject(input: unknown): Result<Project, readonly PlanError[]> {
  const issues: Issues = [];
  const fields = readRecord(
    input, '$', issues, ['origins', 'productionOrigins', 'matrix', 'limits', 'secretNames', 'fixtures', 'policy'], ['origins', 'matrix'],
  );
  if (fields === INVALID) return failure(issues);
  const rawOrigins = readList(fields['origins'], '$.origins', issues, 32);
  const rawMatrix = readList(fields['matrix'], '$.matrix', issues, 64);
  const limits = readLimits(fields['limits'], '$.limits', issues);
  const secretNames = readNameList<'SecretName'>(fields['secretNames'], '$.secretNames', issues, SECRET_NAME);
  // A name such as "a..b" matches the pattern but is refused anyway, so no fixture name looks like a way out.
  const fixtures = readNameList<'FixtureName'>(fields['fixtures'], '$.fixtures', issues, FIXTURE_NAME, (name) => !name.includes('..'));
  const origins = rawOrigins === INVALID ? [] : rawOrigins.map((origin, index) => readOrigin(origin, `$.origins[${index}]`, issues));
  const productionOrigins = readProductionOrigins(fields['productionOrigins'], issues);
  const policy = readPolicy(fields['policy'], '$.policy', issues, limits);
  const matrix = rawMatrix === INVALID ? [] : rawMatrix.map((target, index) => readTarget(target, `$.matrix[${index}]`, issues));
  const seen = new Set<string>();
  matrix.forEach((target, index) => {
    if (target === INVALID) return;
    if (seen.has(target.id)) issues.push({ code: 'duplicate', path: `$.matrix[${index}].id` });
    seen.add(target.id);
  });
  if (issues.length > 0 || limits === INVALID || secretNames === INVALID || fixtures === INVALID
    || productionOrigins === INVALID || policy === INVALID || !allValid(origins) || !allValid(matrix)) return failure(issues);
  return success(brand<ProjectData, 'Project'>({ origins, productionOrigins, matrix, limits, secretNames, fixtures, policy }));
}
