// Decoders for the run values a plan declares (its `values`), the plan clock and value names.
// They are part of the plan parser, which calls them with its own text reader, and the only
// place a ValueName is made. Errors carry a code and a path, never a value.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import {
  DATE_ANCHORS, DATE_FORMATS, GENERATED_VALUE_KINDS,
  type EmailDomain, type GeneratedValue, type PlanClock, type RelativeDay, type SafeText, type ValueName,
} from '@revisum/contracts';
import { brand } from '../brand.ts';
import { INVALID, allValid, peekRecord, readInteger, readOneOf, readRecord, type Issues, type Parsed } from './plan-decoders.ts';
import {
  CLOCK_TIME, EMAIL_LOCAL_PREFIX, FROM_FIELD, MAXIMUM_DAY_OFFSET, MAXIMUM_VALUE_PREFIX_LENGTH, MAXIMUM_VALUES, UNIQUE_NUMBER_DIGITS, VALUE_NAME,
} from './plan-grammar.ts';

// Reads plan text under the parser's rules (safe text, no credential shapes).
export type TextReader = (input: unknown, path: string, maximumLength: number) => Parsed<SafeText>;

// What the value decoders need from the parser: where to record errors, how it reads text, and
// the email domains the trusted project declares.
export type ValueContext = {
  readonly issues: Issues;
  readonly readText: TextReader;
  readonly emailDomains: readonly EmailDomain[];
};

// A value name as text: wrong_type when it is not text, unknown_value when it breaks the pattern.
export function readValueName(input: unknown, path: string, issues: Issues): Parsed<ValueName> {
  if (typeof input !== 'string') { issues.push({ code: 'wrong_type', path }); return INVALID; }
  if (!VALUE_NAME.test(input)) { issues.push({ code: 'unknown_value', path }); return INVALID; }
  return brand<string, 'ValueName'>(input);
}

export function readRelativeDay(input: unknown, path: string, issues: Issues): Parsed<RelativeDay> {
  const fields = readRecord(input, path, issues, [FROM_FIELD, 'addDays']);
  if (fields === INVALID) return INVALID;
  const parts = [
    readOneOf(fields[FROM_FIELD], `${path}.${FROM_FIELD}`, issues, DATE_ANCHORS),
    readInteger(fields['addDays'], `${path}.addDays`, issues, -MAXIMUM_DAY_OFFSET, MAXIMUM_DAY_OFFSET),
  ] as const;
  return allValid(parts) ? { from: parts[0], addDays: parts[1] } : INVALID;
}

export function readPlanClock(input: unknown, path: string, issues: Issues): Parsed<PlanClock> {
  const fields = readRecord(input, path, issues, ['day', 'time']);
  if (fields === INVALID) return INVALID;
  const day = readRelativeDay(fields['day'], `${path}.day`, issues);
  const time = fields['time'];
  if (typeof time !== 'string') { issues.push({ code: 'wrong_type', path: `${path}.time` }); return INVALID; }
  if (!CLOCK_TIME.test(time)) { issues.push({ code: 'unknown_value', path: `${path}.time` }); return INVALID; }
  return day === INVALID ? INVALID : { day, time };
}

// The domain of a unique email: one the project declares. The error never repeats the domain.
function readEmailDomain(input: unknown, path: string, context: ValueContext): Parsed<EmailDomain> {
  if (typeof input !== 'string') { context.issues.push({ code: 'wrong_type', path }); return INVALID; }
  const found = context.emailDomains.find((domain) => domain === input);
  if (found === undefined) { context.issues.push({ code: 'unknown_value', path }); return INVALID; }
  return found;
}

function readGeneratedValue(input: unknown, path: string, context: ValueContext): Parsed<GeneratedValue> {
  const { issues } = context;
  const head = peekRecord(input, path, issues);
  if (head === INVALID) return INVALID;
  const kind = readOneOf(head['kind'], `${path}.kind`, issues, GENERATED_VALUE_KINDS);
  if (kind === INVALID) return INVALID;
  switch (kind) {
    case 'uniqueText': {
      if (readRecord(input, path, issues, ['kind', 'prefix']) === INVALID) return INVALID;
      const prefix = context.readText(head['prefix'], `${path}.prefix`, MAXIMUM_VALUE_PREFIX_LENGTH);
      return prefix === INVALID ? INVALID : { kind, prefix };
    }
    case 'uniqueEmail': {
      if (readRecord(input, path, issues, ['kind', 'localPrefix', 'domain'], ['kind', 'localPrefix']) === INVALID) return INVALID;
      // Only characters every mail system accepts, so the address is always well formed.
      const localPrefix = context.readText(head['localPrefix'], `${path}.localPrefix`, MAXIMUM_VALUE_PREFIX_LENGTH);
      if (localPrefix !== INVALID && !EMAIL_LOCAL_PREFIX.test(localPrefix)) {
        issues.push({ code: 'unknown_value', path: `${path}.localPrefix` });
        return INVALID;
      }
      if (!Object.hasOwn(head, 'domain')) return localPrefix === INVALID ? INVALID : { kind, localPrefix };
      const domain = readEmailDomain(head['domain'], `${path}.domain`, context);
      return localPrefix === INVALID || domain === INVALID ? INVALID : { kind, localPrefix, domain };
    }
    case 'uniqueNumber': {
      if (readRecord(input, path, issues, ['kind', 'digits']) === INVALID) return INVALID;
      const digits = readInteger(head['digits'], `${path}.digits`, issues, UNIQUE_NUMBER_DIGITS.fewest, UNIQUE_NUMBER_DIGITS.most);
      return digits === INVALID ? INVALID : { kind, digits };
    }
    case 'date': {
      if (readRecord(input, path, issues, ['kind', 'day', 'format']) === INVALID) return INVALID;
      const parts = [readRelativeDay(head['day'], `${path}.day`, issues), readOneOf(head['format'], `${path}.format`, issues, DATE_FORMATS)] as const;
      return allValid(parts) ? { kind, day: parts[0], format: parts[1] } : INVALID;
    }
  }
}

// The plan's `values`: generated values by name. Every well-formed name is added to `defined`
// even when its definition is refused, so a step that uses it is not also reported as using an
// undefined value. A malformed name is reported at the values object itself, so it is never echoed.
export function readGeneratedValues(
  input: unknown, path: string, context: ValueContext, defined: Set<string>,
): Parsed<Readonly<Record<string, GeneratedValue>>> {
  const { issues } = context;
  const fields = peekRecord(input, path, issues);
  if (fields === INVALID) return INVALID;
  const names = Object.keys(fields);
  if (names.length > MAXIMUM_VALUES) { issues.push({ code: 'too_large', path }); return INVALID; }
  const entries = names.map((name): Parsed<readonly [string, GeneratedValue]> => {
    if (!VALUE_NAME.test(name)) { issues.push({ code: 'unknown_value', path }); return INVALID; }
    defined.add(name);
    const value = readGeneratedValue(fields[name], `${path}.${name}`, context);
    return value === INVALID ? INVALID : [name, value];
  });
  return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

// A parsed plan's generated values, each with its name typed again: Object.entries gives back
// plain strings, but every key of a parsed plan's values passed readGeneratedValues.
export const generatedValueEntries = (values: Readonly<Record<string, GeneratedValue>> | undefined): readonly (readonly [ValueName, GeneratedValue])[] =>
  Object.entries(values ?? {}).map(([name, value]) => [brand<string, 'ValueName'>(name), value] as const);
