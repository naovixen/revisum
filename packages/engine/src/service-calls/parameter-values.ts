// The one place that says whether a value fits a declared call parameter. The plan parser asks it
// about literal arguments, and reports the problem with a plan error code; the request builder
// asks it about run values once their text is known, and refuses any problem as
// parameter-invalid. Either way the same rules decide.
// See docs/specs/SPEC-32-declared-service-calls.md.
import type { ParameterType, SafeText } from '@revisum/contracts';

// A value that fits its parameter: text, an integer or a boolean.
export type ArgumentValue = SafeText | number | boolean;
// Why a value does not fit: it is of another type, too long, or not one of the values allowed.
export type ArgumentProblem = 'wrong_type' | 'too_long' | 'unknown_value';

// A letter or "_", then up to 62 letters, digits or "_".
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
// A day written year, month and day, such as "2026-11-02".
export const YEAR_MONTH_DAY = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
// A local part, "@" and a domain of at least two labels, with no spaces. Deliberately loose:
// it tells an address from other text, not a deliverable address from an undeliverable one.
const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const MAXIMUM_EMAIL_LENGTH = 254;
// How a run value writes an integer: decimal digits, with a minus sign for a negative one.
const DECIMAL_INTEGER = /^-?[0-9]{1,15}$/;

// True for a real calendar day, so "2026-02-30" is refused.
export function isCalendarDay(text: string): boolean {
  const parts = YEAR_MONTH_DAY.exec(text);
  if (parts === null) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

// Undefined when the value fits the parameter. A secret parameter takes no value at all: only a
// secret by name, which the caller handles before it gets here.
export function argumentProblem(type: ParameterType, value: ArgumentValue): ArgumentProblem | undefined {
  switch (type.kind) {
    case 'text':
      if (typeof value !== 'string') return 'wrong_type';
      return value.length > type.maximumLength ? 'too_long' : undefined;
    case 'identifier':
      if (typeof value !== 'string') return 'wrong_type';
      return IDENTIFIER.test(value) ? undefined : 'unknown_value';
    case 'integer':
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 'wrong_type';
      return value < type.minimum || value > type.maximum ? 'unknown_value' : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : 'wrong_type';
    case 'email':
      if (typeof value !== 'string') return 'wrong_type';
      return value.length <= MAXIMUM_EMAIL_LENGTH && EMAIL.test(value) ? undefined : 'unknown_value';
    case 'yearMonthDay':
      if (typeof value !== 'string') return 'wrong_type';
      return isCalendarDay(value) ? undefined : 'unknown_value';
    case 'oneOf':
      if (typeof value !== 'string') return 'wrong_type';
      return type.values.includes(value) ? undefined : 'unknown_value';
    case 'secret':
      return 'wrong_type';
  }
}

// A run value's text read as the parameter's type: an integer from decimal digits, a boolean from
// "true" or "false", anything else as the text itself. Undefined when it does not fit.
export function runValueArgument(type: ParameterType, text: SafeText): ArgumentValue | undefined {
  const value = ((): ArgumentValue | undefined => {
    switch (type.kind) {
      case 'integer': return DECIMAL_INTEGER.test(text) ? Number(text) : undefined;
      case 'boolean': return text === 'true' ? true : text === 'false' ? false : undefined;
      default: return text;
    }
  })();
  return value !== undefined && argumentProblem(type, value) === undefined ? value : undefined;
}

// The value as it is written into a path segment, a query value or an interpolated string.
export const argumentText = (value: ArgumentValue): string => (typeof value === 'string' ? value : String(value));

// Digits only: an integer that cannot start with a minus sign.
const DIGITS = /^[0-9]+$/;

// True when every value of the type is free of quotes, spaces and separators, so it may be written
// inside a string, such as a statement for a database's HTTP API, without changing what the string
// says. An integer that may be negative is left out: a minus sign after another can start a comment.
export function isInterpolationSafe(type: ParameterType): boolean {
  switch (type.kind) {
    case 'identifier': case 'yearMonthDay': return true;
    case 'integer': return type.minimum >= 0;
    case 'oneOf': return type.values.every((value) => IDENTIFIER.test(value) || DIGITS.test(value) || isCalendarDay(value));
    case 'text': case 'email': case 'boolean': case 'secret': return false;
  }
}
