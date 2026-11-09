// Run values: the values a plan generates for each run, the page's frozen clock, and the
// substitution of value references into steps just before they act. Generation is pure: the
// same seed, clock start, target and project always give the same values, and a new run (a new
// seed or clock start) gives new unique ones. Substitution happens before the policy gate's
// runtime guard, so the guard sees the final text and URL.
import {
    StepType,
    ElementTextKind,
    ElementAssertionKind,
    ElementStateKind,
    StructuralLocatorKind,
    SemanticLocatorKind,
    GeneratedValueKind,
    failure,
    literalText,
    referencedValueName,
    StepCode,
    success,
    type AllowedUrl,
    type ElementAssertion,
    type GeneratedValue,
    type Locator,
    type PathTemplate,
    type Plan,
    type PlanClock,
    type ResolvedActionStep,
    type ResolvedMultiLineText,
    type ResolvedElementAssertion,
    type ResolvedLocator,
    type Result,
    type SafeText,
    type SecretReference,
    type Step,
    type Target,
    type TextOrValue,
    type TimeZone,
    type ValueName,
} from "@revisum/contracts";
import { brand } from "../../foundation/Brand.ts";
import { formatCalendarDay, instantOf, relativeCalendarDay } from "./RelativeCalendarDay.ts";
import { entriesInKeyOrder, sha256 } from "../../foundation/Sha256.ts";
import { normalise } from "../outcome/Verdict.ts";
import { runTimeText } from "../../decoding/ReadRecord.ts";
import { generatedValueEntries } from "../../plan/parse/declarations/ReadPlanClock.ts";
import type { Limits, Project } from "../../project/ParseProject.ts";

// Each run value's text, by name.
export type RunValues = ReadonlyMap<ValueName, SafeText>;

// The part of a project that resolving a step reads.
type LimitsOf = Pick<Project, "limits">;

const NO_VALUES: RunValues = new Map();

// Run-time step failures the engine decides, as opposed to driver errors:
//   value-empty        a value is blank where text is needed, or has no text yet;
//   value-unsafe       a value breaks the safe-text rules, or is "." or ".." as a path segment;
//   value-too-long     a value is longer than the project's maximumTextLength;
//   state-not-exposed  a state check's element does not expose that state in the accessibility
//                      tree, such as a tab whose selection is shown only by a css class;
//   download-not-text  a content check's download is not UTF-8 text;
//   request-not-seen   a response check or a remember from a response found no matching exchange
//                      within the step timeout;
//   script-result-too-large  a page script's result text is over its maximumResultBytes;
//   script-result-invalid    a page script's result text is not JSON, or nests deeper than the
//                      depth limit;
//   command-failed     a database command exited with a code its declaration does not count as success;
//   command-timeout    a database command ran past its timeout and was stopped;
//   command-output-invalid  a database command printed more than its maximumOutputBytes, or output
//                      that is not one JSON value when its declaration reads JSON.
//   value-holds-secret a remember step's element is a field a secret was typed into, or a text any
//                      step would remember holds a secret;
//   capture-left-out   a capture took no image, since a field a secret was typed into is still on
//                      the page but cannot be found to mask it.
export type StepErrorCode =
    | typeof StepCode.ValueEmpty
    | typeof StepCode.ValueUnsafe
    | typeof StepCode.ValueTooLong
    | typeof StepCode.StateNotExposed
    | typeof StepCode.DownloadNotText
    | typeof StepCode.RequestNotSeen
    | typeof StepCode.ScriptResultTooLarge
    | typeof StepCode.ScriptResultInvalid
    | typeof StepCode.CommandFailed
    | typeof StepCode.CommandTimeout
    | typeof StepCode.CommandOutputInvalid
    | typeof StepCode.ValueHoldsSecret
    | typeof StepCode.CaptureLeftOut;

const UNIQUE_PART_LENGTH = 10;
const BASE_36 = 36;
// Longer than any generated value can be: prefixes are at most 100 characters, domains 253.
const MAXIMUM_GENERATED_LENGTH = 1024;

// The digest every unique value of one name in one run derives from. The prefix, the kind, the
// target and the project are left out, so only the seed, the clock start and the name decide it.
const uniqueDigest = (name: ValueName, seed: number, clockStartMilliseconds: number): bigint =>
    BigInt(`0x${sha256(`${seed}:${clockStartMilliseconds}:${name}`)}`);

const uniquePart = (digest: bigint): string =>
    digest.toString(BASE_36).slice(0, UNIQUE_PART_LENGTH);

// A number of exactly `digits` digits whose first digit is never 0.
function uniqueNumber(digest: bigint, digits: number): string {
    const lowest = 10n ** BigInt(digits - 1);
    return String(lowest + (digest % (9n * lowest)));
}

// Pure. The text of one generated value.
export function generateValue(
    name: ValueName,
    value: GeneratedValue,
    seed: number,
    clockStartMilliseconds: number,
    target: Target,
    project: Project,
): SafeText {
    const digest = uniqueDigest(name, seed, clockStartMilliseconds);
    const text = ((): string => {
        switch (value.kind) {
            case GeneratedValueKind.UniqueText:
                return `${value.prefix}-${uniquePart(digest)}`;
            case GeneratedValueKind.UniqueEmail: {
                // The project parser never leaves the list empty; it defaults to example.com.
                const domain = value.domain ?? project.generatedEmailDomains[0];
                if (domain === undefined) {
                    throw new TypeError(
                        "the project declares no email domain for a generated email address",
                    );
                }
                return `${value.localPrefix}-${uniquePart(digest)}@${domain}`;
            }
            case GeneratedValueKind.UniqueNumber:
                return uniqueNumber(digest, value.digits);
            case GeneratedValueKind.Date: {
                const day = relativeCalendarDay(value.day, clockStartMilliseconds, target.timezone);
                return formatCalendarDay(day, value.format, target.locale, target.timezone);
            }
        }
    })();
    // Built from safe text, digits and Intl output, so this never fails; it is still checked, so a
    // generated value is SafeText only because it passed the rules for run-time text. Intl output
    // may hold directional marks, which plan text may not.
    const safe = runTimeText(text, MAXIMUM_GENERATED_LENGTH);
    if (safe === undefined) {
        throw new TypeError(`the generated value ${name} broke the safe-text rules`);
    }
    return safe;
}

// Every value the plan generates, for one run on one target.
export function generateRunValues(
    plan: Plan,
    seed: number,
    clockStartMilliseconds: number,
    target: Target,
    project: Project,
): RunValues {
    const values = new Map<ValueName, SafeText>();
    for (const [name, value] of generatedValueEntries(plan.values)) {
        values.set(name, generateValue(name, value, seed, clockStartMilliseconds, target, project));
    }
    return values;
}

// Pure. The time the page's clock is frozen at: the plan clock's day and time in the target's
// time zone, or the run's clock start when the plan sets no clock. The manifest keeps the run's
// own clock start either way.
export function resolvePlanClock(
    clock: PlanClock | undefined,
    clockStartMilliseconds: number,
    timezone: TimeZone,
): number {
    if (clock === undefined) {
        return clockStartMilliseconds;
    }
    const [hour, minute] = clock.time.split(":").map(Number);
    return instantOf(
        relativeCalendarDay(clock.day, clockStartMilliseconds, timezone),
        hour ?? 0,
        minute ?? 0,
        timezone,
    );
}

// ---- Substitution -------------------------------------------------------------------------------

type Resolved<Value> = Result<Value, StepErrorCode>;

// The one place a value reference is resolved: the text a plan writes, or the text of the value it
// names, held to `maximumLength`. A value with no text yet, such as one a step that never ran
// would have remembered, is value-empty. So is a blank one, which any text contains, so that a
// check against it can prove nothing. A plan's own blank text stays, since a fill may mean it.
export function resolveText(
    text: TextOrValue,
    values: RunValues,
    maximumLength: number,
): Resolved<SafeText> {
    const literal = literalText(text);
    if (literal !== undefined) {
        return success(literal);
    }
    const name = referencedValueName(text);
    const value = name === undefined ? undefined : values.get(name);
    if (value === undefined || normalise(value) === "") {
        return failure("value-empty");
    }
    if (value.length > maximumLength) {
        return failure("value-too-long");
    }
    return success(value);
}

// The locator a driver matches, with its value references replaced. A css or XPath locator's
// selector is always literal; only its hasText, and the locators it is inside, may hold a reference.
export function resolveLocator(
    locator: Locator,
    values: RunValues,
    project: LimitsOf,
): Result<ResolvedLocator, StepErrorCode> {
    switch (locator.by) {
        case SemanticLocatorKind.Role: {
            const name = resolveText(locator.name, values, project.limits.maximumTextLength);
            return name.ok ? success({ ...locator, name: name.value }) : name;
        }
        case SemanticLocatorKind.Label: {
            const label = resolveText(locator.label, values, project.limits.maximumTextLength);
            return label.ok ? success({ ...locator, label: label.value }) : label;
        }
        case SemanticLocatorKind.Text: {
            const text = resolveText(locator.text, values, project.limits.maximumTextLength);
            return text.ok ? success({ ...locator, text: text.value }) : text;
        }
        case SemanticLocatorKind.TestId: {
            const testId = resolveText(locator.testId, values, project.limits.maximumTextLength);
            return testId.ok ? success({ ...locator, testId: testId.value }) : testId;
        }
        case StructuralLocatorKind.Css:
        case StructuralLocatorKind.Xpath: {
            const hasText =
                locator.hasText === undefined
                    ? undefined
                    : resolveText(locator.hasText, values, project.limits.maximumTextLength);
            if (hasText !== undefined && !hasText.ok) {
                return hasText;
            }
            const inside =
                locator.inside === undefined
                    ? undefined
                    : resolveLocator(locator.inside, values, project);
            if (inside !== undefined && !inside.ok) {
                return inside;
            }
            const optional = {
                ...(hasText === undefined ? {} : { hasText: hasText.value }),
                ...(inside === undefined ? {} : { inside: inside.value }),
                ...(locator.position === undefined ? {} : { position: locator.position }),
            };
            return success(
                locator.by === StructuralLocatorKind.Css
                    ? { by: StructuralLocatorKind.Css, selector: locator.selector, ...optional }
                    : {
                          by: StructuralLocatorKind.Xpath,
                          expression: locator.expression,
                          ...optional,
                      },
            );
        }
    }
}

// The check the oracle compares against, with its expected text final.
export function resolveElementAssertion(
    assertion: ElementAssertion,
    values: RunValues,
    project: Project,
): Result<ResolvedElementAssertion, StepErrorCode> {
    switch (assertion.kind) {
        case ElementAssertionKind.HasClass:
        case ElementAssertionKind.LacksClass:
        case ElementAssertionKind.ComputedStyleEquals:
        case ElementAssertionKind.AttributeAbsent:
            return success(assertion);
        case ElementAssertionKind.AttributeEquals: {
            const value = resolveText(assertion.value, values, project.limits.maximumTextLength);
            return value.ok
                ? success({ kind: assertion.kind, name: assertion.name, value: value.value })
                : value;
        }
        case ElementAssertionKind.CountEquals:
            return success(assertion);
        case ElementTextKind.TextEquals:
        case ElementTextKind.TextContains:
        case ElementTextKind.ValueEquals:
        case ElementTextKind.ValueContains:
        case ElementAssertionKind.HrefEquals: {
            const value = resolveText(assertion.value, values, project.limits.maximumTextLength);
            return value.ok ? success({ kind: assertion.kind, value: value.value }) : value;
        }
        // The state checks compare against nothing.
        case ElementStateKind.Visible:
        case ElementStateKind.Hidden:
        case ElementStateKind.Enabled:
        case ElementStateKind.Disabled:
        case ElementStateKind.Absent:
        case ElementStateKind.Checked:
        case ElementStateKind.Unchecked:
        case ElementStateKind.Focused:
        case ElementStateKind.Selected:
        case ElementStateKind.Unselected:
        case ElementStateKind.Expanded:
        case ElementStateKind.Collapsed:
        case ElementStateKind.Pressed:
        case ElementStateKind.Unpressed:
        case ElementStateKind.Current:
            return success(assertion);
    }
}

// The lines of a multi-line fill with every value replaced. Each line is held to the project's
// maximumTextLength, and the lines with the line feeds between them to maximumFillCharacters:
// the parser checked the literal lines, but a value's text is only known now.
function resolveLines(
    lines: readonly TextOrValue[],
    values: RunValues,
    project: LimitsOf,
): Resolved<ResolvedMultiLineText> {
    const resolved: SafeText[] = [];
    for (const line of lines) {
        const text = resolveText(line, values, project.limits.maximumTextLength);
        if (!text.ok) {
            return text;
        }
        resolved.push(text.value);
    }
    const characters =
        resolved.reduce((total, line) => total + line.length, 0) + Math.max(resolved.length - 1, 0);
    return characters > project.limits.maximumFillCharacters
        ? failure("value-too-long")
        : success({ lines: resolved });
}

type FillStep = Extract<Step, { type: "fill" }>;
// What a fill types when it is not a secret: text, a value reference or several lines.
export type FillText = Exclude<FillStep["value"], SecretReference>;
// An action step other than a fill.
export type InputStep = Extract<Step, { type: Exclude<ResolvedActionStep["type"], "fill"> }>;
export type ResolvedInputStep = Exclude<ResolvedActionStep, { type: "fill" }>;

// The text a fill types, with every value replaced.
export function resolveFillText(
    value: FillText,
    values: RunValues,
    project: LimitsOf,
): Resolved<SafeText | ResolvedMultiLineText> {
    if (typeof value === "object" && "lines" in value) {
        return resolveLines(value.lines, values, project);
    }
    return resolveText(value, values, project.limits.maximumTextLength);
}

// An action other than a fill as a driver performs it, with every value replaced.
export function resolveInputStep(
    step: InputStep,
    values: RunValues,
    project: LimitsOf,
): Result<ResolvedInputStep, StepErrorCode> {
    const locator = resolveLocator(step.locator, values, project);
    if (!locator.ok) {
        return locator;
    }
    switch (step.type) {
        case StepType.Click:
        case StepType.Hover:
            return success({ type: step.type, locator: locator.value });
        case StepType.Upload:
            return success({ type: step.type, locator: locator.value, fixture: step.fixture });
        case StepType.Press:
            return success({ ...step, locator: locator.value });
        case StepType.Select: {
            const option = resolveText(step.option, values, project.limits.maximumTextLength);
            return option.ok
                ? success({ type: step.type, locator: locator.value, option: option.value })
                : option;
        }
    }
}

// The action a driver performs, with every value replaced.
export function resolveActionStep(
    step: Extract<Step, { type: ResolvedActionStep["type"] }>,
    values: RunValues,
    project: LimitsOf,
): Result<ResolvedActionStep, StepErrorCode> {
    if (step.type !== StepType.Fill) {
        return resolveInputStep(step, values, project);
    }
    const locator = resolveLocator(step.locator, values, project);
    if (!locator.ok) {
        return locator;
    }
    const value = step.value;
    if (typeof value === "object" && "secretName" in value) {
        return success({ type: step.type, locator: locator.value, value });
    }
    const text = resolveFillText(value, values, project);
    return text.ok ? success({ type: step.type, locator: locator.value, value: text.value }) : text;
}

// A locator or action step holding only literal text, as a driver takes it: what a caller that hands
// a driver a step itself, with no run around it, gets from the engine. A value reference in it has no
// text outside a run, so it is value-empty.
export const resolveLiteralLocator = (
    locator: Locator,
    limits: Limits,
): Result<ResolvedLocator, StepErrorCode> => resolveLocator(locator, NO_VALUES, { limits });

export const resolveLiteralActionStep = (
    step: Extract<Step, { type: ResolvedActionStep["type"] }>,
    limits: Limits,
): Result<ResolvedActionStep, StepErrorCode> => resolveActionStep(step, NO_VALUES, { limits });

// One path segment or query value, percent-encoded as a whole, so "/", "?", "#" and "%" inside a
// value stay inside it. An empty value, "." or ".." would drop or climb a segment.
function encodeSegment(text: SafeText): Resolved<string> {
    if (text === "" || text === "." || text === "..") {
        return failure("value-unsafe");
    }
    return success(encodeURIComponent(text));
}

// The URL a path template names: a path from the root of the run's base URL, with its query.
// Every segment is non-empty once encoded, so the path never starts with "//" and the origin is
// always the base URL's.
export function resolvePathTemplate(
    template: PathTemplate,
    values: RunValues,
    project: Project,
): Resolved<AllowedUrl> {
    const segments: string[] = [];
    for (const segment of template.segments) {
        const text = resolveText(segment, values, project.limits.maximumTextLength);
        if (!text.ok) {
            return text;
        }
        const encoded = encodeSegment(text.value);
        if (!encoded.ok) {
            return encoded;
        }
        segments.push(encoded.value);
    }
    const query: string[] = [];
    // In key order, because a plan's hash ignores the order its keys are written in: two plans with
    // one hash must go to one URL.
    for (const [key, value] of entriesInKeyOrder(template.query ?? {})) {
        const text = resolveText(value, values, project.limits.maximumTextLength);
        if (!text.ok) {
            return text;
        }
        query.push(`${encodeURIComponent(key)}=${encodeURIComponent(text.value)}`);
    }
    return success(
        brand<string, "AllowedUrl">(
            `/${segments.join("/")}${query.length === 0 ? "" : `?${query.join("&")}`}`,
        ),
    );
}
