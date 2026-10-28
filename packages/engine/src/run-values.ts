// Run values: the values a plan generates for each run, the page's frozen clock, and the
// substitution of value references into steps just before they act. Generation is pure: the
// same seed, clock start, target and project always give the same values, and a new run (a new
// seed or clock start) gives new unique ones. Substitution happens before the policy gate's
// runtime guard, so the guard sees the final text and URL.
// See docs/specs/SPEC-30-plan-values-positions-and-keys.md.
import {
  failure, literalText, referencedValueName, success,
  type AllowedUrl, type ElementAssertion, type GeneratedValue, type Locator, type PathTemplate, type Plan,
  type PlanClock, type ResolvedActionStep, type ResolvedElementAssertion, type ResolvedLocator, type Result, type SafeText, type Step, type Target,
  type TextOrValue, type TimeZone, type ValueName,
} from '@revisum/contracts';
import { brand } from './brand.ts';
import { formatCalendarDay, instantOf, relativeCalendarDay } from './calendar.ts';
import { sha256 } from './hashing.ts';
import { runTimeText } from './plan/plan-decoders.ts';
import { generatedValueEntries } from './plan/plan-values.ts';
import type { Project } from './project/project-parser.ts';

// Each run value's text, by name.
export type RunValues = ReadonlyMap<ValueName, SafeText>;

// Run-time step failures the engine decides, as opposed to driver errors:
//   value-empty        a value is empty where text is needed, or has no text yet;
//   value-unsafe       a value breaks the safe-text rules, or is "", "." or ".." as a path segment;
//   value-too-long     a value is longer than the project's maximumTextLength;
//   state-not-exposed  a state check's element does not expose that state in the accessibility
//                      tree, such as a tab whose selection is shown only by a CSS class;
//   download-not-text  a content check's download is not UTF-8 text.
export type StepErrorCode = 'value-empty' | 'value-unsafe' | 'value-too-long' | 'state-not-exposed' | 'download-not-text';

const UNIQUE_PART_LENGTH = 10;
const BASE_36 = 36;
// Longer than any generated value can be: prefixes are at most 100 characters, domains 253.
const MAXIMUM_GENERATED_LENGTH = 1024;

// The digest every unique value of one name in one run derives from. The prefix, the kind, the
// target and the project are left out, so only the seed, the clock start and the name decide it.
const uniqueDigest = (name: ValueName, seed: number, clockStartMilliseconds: number): bigint =>
  BigInt(`0x${sha256(`${seed}:${clockStartMilliseconds}:${name}`)}`);

const uniquePart = (digest: bigint): string => digest.toString(BASE_36).slice(0, UNIQUE_PART_LENGTH);

// A number of exactly `digits` digits whose first digit is never 0.
function uniqueNumber(digest: bigint, digits: number): string {
  const lowest = 10n ** BigInt(digits - 1);
  return String(lowest + (digest % (9n * lowest)));
}

// Pure. The text of one generated value.
export function generateValue(
  name: ValueName, value: GeneratedValue, seed: number, clockStartMilliseconds: number, target: Target, project: Project,
): SafeText {
  const digest = uniqueDigest(name, seed, clockStartMilliseconds);
  const text = ((): string => {
    switch (value.kind) {
      case 'uniqueText': return `${value.prefix}-${uniquePart(digest)}`;
      case 'uniqueEmail': {
        // The project parser never leaves the list empty; it defaults to example.com.
        const domain = value.domain ?? project.generatedEmailDomains[0];
        if (domain === undefined) throw new TypeError('the project declares no email domain for a generated email address');
        return `${value.localPrefix}-${uniquePart(digest)}@${domain}`;
      }
      case 'uniqueNumber': return uniqueNumber(digest, value.digits);
      case 'date': {
        const day = relativeCalendarDay(value.day, clockStartMilliseconds, target.timezone);
        return formatCalendarDay(day, value.format, target.locale, target.timezone);
      }
    }
  })();
  // Built from safe text, digits and Intl output, so this never fails; it is still checked, so a
  // generated value is SafeText only because it passed the same rules as plan text.
  const safe = runTimeText(text, MAXIMUM_GENERATED_LENGTH);
  if (safe === undefined) throw new TypeError(`the generated value ${name} broke the safe-text rules`);
  return safe;
}

// Every value the plan generates, for one run on one target.
export function generateRunValues(plan: Plan, seed: number, clockStartMilliseconds: number, target: Target, project: Project): RunValues {
  const values = new Map<ValueName, SafeText>();
  for (const [name, value] of generatedValueEntries(plan.values)) {
    values.set(name, generateValue(name, value, seed, clockStartMilliseconds, target, project));
  }
  return values;
}

// Pure. The time the page's clock is frozen at: the plan clock's day and time in the target's
// time zone, or the run's clock start when the plan sets no clock. The manifest keeps the run's
// own clock start either way.
export function resolvePlanClock(clock: PlanClock | undefined, clockStartMilliseconds: number, timezone: TimeZone): number {
  if (clock === undefined) return clockStartMilliseconds;
  const [hour, minute] = clock.time.split(':').map(Number);
  return instantOf(relativeCalendarDay(clock.day, clockStartMilliseconds, timezone), hour ?? 0, minute ?? 0, timezone);
}

// ---- Substitution -------------------------------------------------------------------------------

type Resolved<Value> = Result<Value, StepErrorCode>;

// The text a plan writes or a value it names, held to the project's text length.
function resolveText(text: TextOrValue, values: RunValues, project: Project): Resolved<SafeText> {
  const literal = literalText(text);
  if (literal !== undefined) return success(literal);
  const name = referencedValueName(text);
  const value = name === undefined ? undefined : values.get(name);
  if (value === undefined) return failure('value-empty');
  if (value.length > project.limits.maximumTextLength) return failure('value-too-long');
  return success(value);
}

export function resolveLocator(locator: Locator, values: RunValues, project: Project): Resolved<ResolvedLocator> {
  switch (locator.by) {
    case 'role': {
      const name = resolveText(locator.name, values, project);
      return name.ok ? success({ ...locator, name: name.value }) : name;
    }
    case 'label': {
      const label = resolveText(locator.label, values, project);
      return label.ok ? success({ ...locator, label: label.value }) : label;
    }
    case 'text': {
      const text = resolveText(locator.text, values, project);
      return text.ok ? success({ ...locator, text: text.value }) : text;
    }
    case 'testId': {
      const testId = resolveText(locator.testId, values, project);
      return testId.ok ? success({ ...locator, testId: testId.value }) : testId;
    }
  }
}

export function resolveElementAssertion(assertion: ElementAssertion, values: RunValues, project: Project): Resolved<ResolvedElementAssertion> {
  if (assertion.kind === 'countEquals' || !('value' in assertion)) return success(assertion);
  const value = resolveText(assertion.value, values, project);
  return value.ok ? success({ kind: assertion.kind, value: value.value }) : value;
}

// The action a driver performs, with every value replaced. A multi-line fill has no driver form
// yet, so it is unsupported here; the run reports it before it gets this far.
export function resolveActionStep(
  step: Extract<Step, { type: ResolvedActionStep['type'] }>, values: RunValues, project: Project,
): Result<ResolvedActionStep, StepErrorCode | 'unsupported-step'> {
  const locator = resolveLocator(step.locator, values, project);
  if (!locator.ok) return locator;
  switch (step.type) {
    case 'click': case 'hover': return success({ type: step.type, locator: locator.value });
    case 'upload': return success({ type: step.type, locator: locator.value, fixture: step.fixture });
    case 'press': return success({ ...step, locator: locator.value });
    case 'select': {
      const option = resolveText(step.option, values, project);
      return option.ok ? success({ type: step.type, locator: locator.value, option: option.value }) : option;
    }
    case 'fill': {
      if (typeof step.value === 'object' && 'lines' in step.value) return failure('unsupported-step');
      if (typeof step.value === 'object' && 'secretName' in step.value) return success({ type: step.type, locator: locator.value, value: step.value });
      const value = resolveText(step.value, values, project);
      return value.ok ? success({ type: step.type, locator: locator.value, value: value.value }) : value;
    }
  }
}

// One path segment or query value, percent-encoded as a whole, so "/", "?", "#" and "%" inside a
// value stay inside it. An empty value, "." or ".." would drop or climb a segment.
function encodeSegment(text: SafeText): Resolved<string> {
  if (text === '' || text === '.' || text === '..') return failure('value-unsafe');
  return success(encodeURIComponent(text));
}

// The URL a path template names: a path from the root of the run's base URL, with its query.
// Every segment is non-empty once encoded, so the path never starts with "//" and the origin is
// always the base URL's.
export function resolvePathTemplate(template: PathTemplate, values: RunValues, project: Project): Resolved<AllowedUrl> {
  const segments: string[] = [];
  for (const segment of template.segments) {
    const text = resolveText(segment, values, project);
    if (!text.ok) return text;
    const encoded = encodeSegment(text.value);
    if (!encoded.ok) return encoded;
    segments.push(encoded.value);
  }
  const query: string[] = [];
  for (const [key, value] of Object.entries(template.query ?? {})) {
    const text = resolveText(value, values, project);
    if (!text.ok) return text;
    query.push(`${encodeURIComponent(key)}=${encodeURIComponent(text.value)}`);
  }
  return success(brand<string, 'AllowedUrl'>(`/${segments.join('/')}${query.length === 0 ? '' : `?${query.join('&')}`}`));
}
