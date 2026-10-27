// The trusted project: allowed origins, the "test with" matrix and limits, written by a person.
// AI output never reaches this type. The person declares every target; the engine never invents one.
import {
  COLOR_SCHEMES, DEVICE_PROFILES, ENGINES, MOTION_PREFERENCES, success, failure,
  type Brand, type DeviceProfileId, type Locale, type Origin, type Result, type Target, type TimeZone,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import {
  INVALID, allValid, readInteger, readList, readOneOf, readRecord, type Issues, type Parsed, type PlanError,
} from '../plan/plan-decoders.ts';

const DEVICE_IDS = Object.keys(DEVICE_PROFILES) as DeviceProfileId[];

export type Limits = {
  readonly maximumPlanBytes: number;
  readonly maximumSteps: number;
  readonly maximumTextLength: number;
  readonly stepTimeoutMilliseconds: number;
};
export const DEFAULT_LIMITS: Limits = { maximumPlanBytes: 64 * 1024, maximumSteps: 100, maximumTextLength: 500, stepTimeoutMilliseconds: 5000 };

export type ProjectData = {
  readonly origins: readonly Origin[];
  readonly matrix: readonly Target[];
  readonly limits: Limits;
};
export type Project = Brand<ProjectData, 'Project'>;

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

// A lowercase id such as a target or adapter id.
export function readId<Name extends string>(input: unknown, path: string, issues: Issues): Parsed<Brand<string, Name>> {
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (!ID.test(input)) { issues.push({ code: 'unknown_value', path }); return INVALID; }
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

function readLocale(input: unknown, path: string, issues: Issues): Parsed<Locale> {
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

const LIMIT_KEYS = ['maximumPlanBytes', 'maximumSteps', 'maximumTextLength', 'stepTimeoutMilliseconds'] as const;

function readLimits(input: unknown, path: string, issues: Issues): Parsed<Limits> {
  if (input === undefined) return DEFAULT_LIMITS;
  const fields = readRecord(input, path, issues, LIMIT_KEYS, []);
  if (fields === INVALID) return INVALID;
  const pick = (key: (typeof LIMIT_KEYS)[number], highest: number): Parsed<number> =>
    fields[key] === undefined ? DEFAULT_LIMITS[key] : readInteger(fields[key], `${path}.${key}`, issues, 1, highest);
  const parts = [pick('maximumPlanBytes', 1 << 20), pick('maximumSteps', 1000), pick('maximumTextLength', 4000), pick('stepTimeoutMilliseconds', 60_000)] as const;
  if (!allValid(parts)) return INVALID;
  const [maximumPlanBytes, maximumSteps, maximumTextLength, stepTimeoutMilliseconds] = parts;
  return { maximumPlanBytes, maximumSteps, maximumTextLength, stepTimeoutMilliseconds };
}

export function parseProject(input: unknown): Result<Project, readonly PlanError[]> {
  const issues: Issues = [];
  const fields = readRecord(input, '$', issues, ['origins', 'matrix', 'limits'], ['origins', 'matrix']);
  if (fields === INVALID) return failure(issues);
  const rawOrigins = readList(fields['origins'], '$.origins', issues, 32);
  const rawMatrix = readList(fields['matrix'], '$.matrix', issues, 64);
  const limits = readLimits(fields['limits'], '$.limits', issues);
  const origins = rawOrigins === INVALID ? [] : rawOrigins.map((origin, index) => readOrigin(origin, `$.origins[${index}]`, issues));
  const matrix = rawMatrix === INVALID ? [] : rawMatrix.map((target, index) => readTarget(target, `$.matrix[${index}]`, issues));
  const seen = new Set<string>();
  matrix.forEach((target, index) => {
    if (target === INVALID) return;
    if (seen.has(target.id)) issues.push({ code: 'duplicate', path: `$.matrix[${index}].id` });
    seen.add(target.id);
  });
  if (issues.length > 0 || limits === INVALID || !allValid(origins) || !allValid(matrix)) return failure(issues);
  return success(brand<ProjectData, 'Project'>({ origins, matrix, limits }));
}
