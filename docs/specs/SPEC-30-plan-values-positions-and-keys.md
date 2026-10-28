# SPEC-30: Plan language 1.2: run values, positions, key chords and longer text

## Purpose

The coverage study found 38 of 100 sampled test intents expressible in plan v1.1, against a kill threshold of 70% (`docs/coverage-study/report.md`). This spec closes the gaps that need no new authority: values unique to each run, dates relative to the run's frozen clock, values read from the page and reused, positional locators, declared test-id attributes, key chords, multi-line text and a URL-prefix check. It serves "AI writes features faster than we can check them" (UP-01): more real tests fit the closed language, so fewer stay outside the evidence. It also owns the bump to plan language 1.2, which SPEC-31, SPEC-32 and SPEC-33 extend. Outcome: plan 1.2 parses every 1.1 plan unchanged, adds the features below as closed, typed data, and keeps every run deterministic and replayable.

## Scope and non-goals

- **In:**
  - **Version 1.2.** This spec owns the bump of `PLAN_VERSION` to 1.2, the regeneration of `docs/plan-language/plan.schema.json` and the changelog entry. It opens an entry "1.2 (unreleased)" at the top of `docs/plan-language/CHANGELOG.md`. SPEC-31, SPEC-32 and SPEC-33 each add their bullets to that entry and record the new schema hash in it. The entry is dated when the last of their parser parts lands.
    - A plan declaring `"1.2"` may use every 1.2 feature. A plan declaring `"1.1"` parses exactly as it did under 1.1, with no migration, because 1.1 is a subset of 1.2. A 1.2 field or step in a plan that declares `"1.1"` is rejected with the code a 1.1 parser gives (`unknown_field`, `unknown_step` or `unknown_value`).
    - Version 1 plans are still accepted only through `migratePlan` (SPEC-01), which now outputs a 1.1 plan, still accepted.
  - **Run values.** A plan may name values and use them where it would write literal text:
    - *generated values*, declared in the plan's `values`: unique text, a unique email address, a unique number, or a date relative to the frozen clock. Each derives from the run's seed and clock start, which the manifest records (SPEC-08). The same manifest gives the same values, and a new run gives new ones;
    - *remembered values*, read by a `remember` step from one element's text or input value, then reused by later steps;
    - references `{ "valueName": … }`, allowed only in: `fill` values and lines, `select` options, locator names, labels, texts and test ids, text assertions' expected values, `dialog` expected text, and the segments and query values of a path template. Never in an origin, a key, a criterion id, a capture name, a target or the name of anything the project declares.
  - **Path templates.** `navigate` may take a path built from literal and value segments plus query values. Each value is percent-encoded as a whole segment or query value. The origin is always the run's base URL, so no value can change where the browser goes.
  - **Plan clock.** A plan may set the page's frozen clock relative to the run's clock start, for example "the first of next month, 09:00". The frozen clock and date values use the target's time zone.
  - **Positional locators.** Every locator kind takes an optional `position`: `first`, `last` or a 1-based index, in document order. A positioned locator resolves to at most one element.
  - **Declared test-id attributes.** The project lists the attributes a `testId` locator may match (default `data-testid`). A locator may name one of them with `attribute`. The driver matches by exact string equality on that attribute. It never builds a selector from plan text.
  - **Key chords.** `press` takes optional `modifiers`, and the key list gains letters, digits, punctuation keys and F1 to F12.
  - **Multi-line text.** A `fill` value may be `{ "lines": […] }`. The lines are joined with line feeds and inserted as text, with no Enter key press, so a chat box does not send early.
  - **URL prefix.** A new page assertion, `urlPathStartsWith`.
  - **Coverage study input.** `intents.json` may give each suite a project, with the declarations SPEC-30 to SPEC-33 add. Each intent's plan is parsed with its suite's project.
- **Non-goals:**
  - branching, loops, conditions, arithmetic or string operations on values. Plans stay straight-line, so what a plan does is fixed when a person approves it;
  - regular expressions anywhere in a plan: they invite catastrophic backtracking and encode logic;
  - remembering an element's attribute, class or computed style (for example a post id held only in an attribute): it would reopen CSS-style probing of the page;
  - filtered positions such as "the first enabled match";
  - advancing the virtual clock during a run (open question in `docs/decisions/plan-language-extensions.md`);
  - random values not derived from the seed;
  - readable text forms for the new features. SPEC-28 owns the readable form; until it adds them, 1.2 features are written in JSON. No second parser is added.

## Interfaces and types

```ts
// contracts. Shapes not shown are as in plan 1.1 (SPEC-01).
export const PLAN_VERSION = { major: 1, minor: 2 } as const;       // plans declaring "1.1" still parse unchanged

export type ValueName = Brand<string, 'ValueName'>;                // ^[a-z][A-Za-z0-9]{0,63}$, defined once per plan
export type ValueReference = { readonly valueName: ValueName };
export type TextOrValue = SafeText | ValueReference;

export const DATE_ANCHORS = ['today', 'startOfWeek', 'startOfMonth', 'startOfNextMonth'] as const;  // weeks start on Monday
export type DateAnchor = (typeof DATE_ANCHORS)[number];
// yearMonthDay "2026-11-02"; dayOfMonth "2"; monthAndYear "November 2026", longDate "2 November 2026" and weekday
// "Monday" in the target's locale through Intl; timestamp "2026-11-02T09:00:00.000Z"; epochMilliseconds "1793610000000".
export const DATE_FORMATS = ['yearMonthDay', 'dayOfMonth', 'monthAndYear', 'longDate', 'weekday', 'timestamp', 'epochMilliseconds'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];
export type RelativeDay = { readonly from: DateAnchor; readonly addDays: number };   // integer, -3660 to 3660

export type EmailDomain = Brand<string, 'EmailDomain'>;            // one of the project's generatedEmailDomains
export type GeneratedValue =
  | { readonly kind: 'uniqueText'; readonly prefix: SafeText }                       // prefix + "-" + 10 base-36 characters
  | { readonly kind: 'uniqueEmail'; readonly localPrefix: SafeText; readonly domain?: EmailDomain } // default: first declared domain
  | { readonly kind: 'uniqueNumber'; readonly digits: number }                       // 4 to 12 digits, no leading zero
  | { readonly kind: 'date'; readonly day: RelativeDay; readonly format: DateFormat };

// The page's frozen clock, relative to the run's clock start, in the target's time zone. "HH:MM", 24-hour.
export type PlanClock = { readonly day: RelativeDay; readonly time: string };

export type Position = 'first' | 'last' | number;                  // number: 1-based index, 1 to 1000, document order
export type TestIdAttribute = Brand<string, 'TestIdAttribute'>;    // "id" or "data-…", declared in the project
export type Locator =
  | { readonly by: 'role'; readonly role: Role; readonly name: TextOrValue; readonly position?: Position }
  | { readonly by: 'label'; readonly label: TextOrValue; readonly position?: Position }
  | { readonly by: 'text'; readonly text: TextOrValue; readonly position?: Position }
  | { readonly by: 'testId'; readonly testId: TextOrValue; readonly attribute?: TestIdAttribute; readonly position?: Position };

// ControlOrMeta is Meta on macOS and iOS targets and Control on every other target.
export const MODIFIERS = ['Alt', 'Control', 'Meta', 'Shift', 'ControlOrMeta'] as const;
export type Modifier = (typeof MODIFIERS)[number];
export const KEYS = [
  /* the 14 keys of 1.1 */ 'Enter', 'Space', 'Tab', 'Escape', 'Backspace', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  /* 'a' to 'z' and '0' to '9', listed in full in the code */
  'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  /* 'F1' to 'F12' */
] as const;

export type MultiLineText = { readonly lines: readonly TextOrValue[] };   // joined with "\n"
// A path on the run's base URL. Literal segments hold no "/", "?" or "#"; query keys match ^[A-Za-z0-9_.-]{1,64}$.
export type PathTemplate = { readonly segments: readonly TextOrValue[]; readonly query?: Readonly<Record<string, TextOrValue>> };

// Steps that change or join the union in 1.2 (this spec):
//  | { type: 'navigate'; url: AllowedUrl | PathTemplate }
//  | { type: 'fill'; locator: Locator; value: TextOrValue | SecretReference | MultiLineText }
//  | { type: 'select'; locator: Locator; option: TextOrValue }
//  | { type: 'press'; locator: Locator; key: Key; modifiers?: readonly Modifier[] }      // 1 to 4, distinct
//  | { type: 'dialog'; action: 'accept' | 'dismiss'; expectText?: TextOrValue }
//  | { type: 'remember'; name: ValueName; from: RememberSource }
export type RememberSource = { readonly element: Locator; readonly read: 'text' | 'value' };  // SPEC-33 adds a response source
// Text assertions (textEquals, textContains, valueEquals, valueContains) take value: TextOrValue.
// PageAssertion gains: | { kind: 'urlPathStartsWith'; value: SafeText }   // starts with "/"; a plain text prefix
// PlanData gains: values?: Readonly<Record<ValueName, GeneratedValue>>; clock?: PlanClock.

// Project file additions (parser view; SPEC-02 owns the file):
//   testIdAttributes: readonly TestIdAttribute[]          default ['data-testid']; each "id" or ^data-[a-z0-9]+(-[a-z0-9]+)*$
//   generatedEmailDomains: readonly EmailDomain[]         default ['example.com']
//   limits.maximumFillLines                               default 50, at most 500
//   limits.maximumFillCharacters                          default 4000, at most 20000

// engine
export type RunValues = ReadonlyMap<ValueName, SafeText>;
// Pure. The unique part is the first 10 base-36 characters of sha256(`${seed}:${clockStartMilliseconds}:${name}`).
export function generateValue(name: ValueName, value: GeneratedValue, seed: number, clockStartMilliseconds: number,
  target: Target, project: Project): SafeText;
// Pure. Returns the page's frozen time; the manifest keeps the run's own clock start unchanged.
export function resolvePlanClock(clock: PlanClock | undefined, clockStartMilliseconds: number, timezone: TimeZone): number;
// Run-time step failures the engine decides, as opposed to driver errors. SPEC-31 to SPEC-33 add codes.
export type StepErrorCode = 'value-empty' | 'value-unsafe' | 'value-too-long';
// PlanErrorCode additions: 'undefined_value' | 'position_not_allowed'.
```

**Rules the criteria rely on.**

- **Definitions come first.** The plan's `values` are visible to every step. A `remember` step's value is visible to every step after it in document order, inside or outside a frame. A reference to a name not yet defined fails with `undefined_value`. A name defined twice fails with `duplicate`.
- **Remembered values are page content.** The interpreter reads the value through `Prober.probe`, so no new driver method is needed. It waits, like `expect`, until the locator matches exactly one element with non-empty text, then normalises whitespace. The value must pass the `SafeText` rules and the project's `maximumTextLength`. The result, logs and events record the value's name and sha256, never the value; logging goes through the redactor.
- **Substitution.** Generated values are safe by construction. A value used as a path segment must not be empty, `.` or `..` (`value-unsafe`). Every substitution happens before the policy gate's runtime guard (SPEC-03), so destructive-navigation patterns see the final URL.
- **Positions.** With a position, the driver takes the matches in document order and picks one. A missing position gives a probe count of 0 (`not-found`). The oracle's rule that a count other than 1 is a failure stays unchanged. `countEquals` and `absent` on a positioned locator fail with `position_not_allowed`.
- **Chords and the policy gate.** The runtime guard treats `press` of Enter or Space with any modifiers exactly as without them (`irreversible-submit`, SPEC-03).

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; `docs/decisions/answers.md`):

- **Version test.** SPEC-01's future-version example moves from `1.2` to `1.3` (founder, 2026-10-28).
- **Coverage study input (AC-SPEC-30-18).** `intents.json` gains `suites: { <suite name>: { project } }`. Each intent gains `sample: 'original' | 'fresh'`. `assessCoverage` reports one share per sample, plus the combined share.
- **Manifest.** The plan clock is recorded in the existing `clock.fixedTimeMilliseconds`, not a new `clockStartMilliseconds`. The Intl data version (Node and ICU) joins the manifest with SPEC-08, which owns its fields. Until then AC-SPEC-30-20 checks only the dependency rule.
- **Values.**
  - A date's `timestamp` and `epochMilliseconds` name midnight at the start of that day in the plan clock's time zone.
  - The unique part of a generated value is the first 10 base-36 characters of the sha256 of its inputs.
  - `maximumFillCharacters` counts the line breaks between lines.
- **Paths.**
  - A path segment written literally as `.` or `..` is rejected as `invalid_url` at parse time.
  - Error paths: `undefined_value` at the reference; `position_not_allowed` at `.locator.position`; a fill over its limits at the offending line.
- **Capture names.** A capture name that isn't text is `wrong_type`, as every other field's is, not `unknown_value`.
- **Function keys.** The naming lint allows the key names `F1` to `F12` as string values. They are keyboard keys, not research ids.
- **Deferred to SPEC-06.** `remember` (AC-SPEC-30-09, 10) and the browser halves of AC-SPEC-30-06, 11 to 16.

## Acceptance criteria

- AC-SPEC-30-01: When every 1.1 golden plan is parsed by the 1.2 parser, each shall give a `Plan` deep-equal to its 1.1 result. When a plan declaring `"1.1"` uses any 1.2 field or step, it shall be rejected with the code and path a 1.1 parser gives (oracle: regression).
- AC-SPEC-30-02: When the schema is regenerated, it shall validate every 1.1 golden plan and one new 1.2 golden plan per feature in this spec. The "1.2" changelog entry shall name its sha256, and a schema change without an entry update shall fail `npm run lint` (oracle: specified; extends AC-SPEC-01-10).
- AC-SPEC-30-03: When a plan's generated values are computed twice from the same seed, clock start, target and project, they shall be identical. When the seed or the clock start differs, every unique value shall differ. Across 10,000 seeds no two `uniqueText` values shall collide (oracle: metamorphic).
- AC-SPEC-30-04: When a `uniqueEmail` names a domain the project does not declare, the parser shall reject it with `unknown_value` and its path. Every generated email shall be `<localPrefix>-<unique part>@<domain>` and pass the `SafeText` rules (oracle: specified).
- AC-SPEC-30-05: When date values are computed from the fixture table of clock starts, time zones, locales, anchors and offsets, each shall equal its expected text. The table includes a daylight-saving change, 31 January plus one month, 29 February, week starts and `Asia/Tokyo` against `America/Los_Angeles` across midnight (oracle: specified).
- AC-SPEC-30-06: When a plan sets `clock`, the page's `Date.now()` shall equal `resolvePlanClock`'s result, the manifest's `clockStartMilliseconds` shall be the run's own, and 20 replays shall give identical result hashes (oracle: regression).
- AC-SPEC-30-07: When a plan references a value before its definition or never defines it, the parser shall reject it with `undefined_value` and the reference's path. When a name is defined twice, it shall reject it with `duplicate`. In both cases zero driver calls shall be made (oracle: specified).
- AC-SPEC-30-08: When a value reference appears anywhere other than the allowed places (a criterion id, capture name, target, key, secret name, absolute URL or origin, or the name of a project declaration), the parser shall reject it with `wrong_type` or `unknown_field` and its path, echoing no value (oracle: specified; one hostile plan per place).
- AC-SPEC-30-09: When a `remember` step reads empty text, script-like text or text over the length limit, the step shall fail with `value-empty`, `value-unsafe` or `value-too-long`, the run shall end `Failed` at that step, and no later step shall dispatch input (oracle: specified).
- AC-SPEC-30-10: When the leak scan runs over the result, logs, events and report of a run that remembered planted canary text, it shall find the canary nowhere. Only the value's name and sha256 shall appear (oracle: specified; extends AC-SPEC-04-04).
- AC-SPEC-30-11: When a path template is resolved with 1,000 generated values, including "/", "?", "#", "%2F", "..", spaces and non-Latin text, the URL's origin shall always be the base URL's, and its path shall have exactly the template's number of segments. A value of "", "." or ".." shall fail the step with `value-unsafe` before any navigation. A literal segment holding "/", "?" or "#" shall be rejected at parse time with `unknown_value` (oracle: metamorphic).
- AC-SPEC-30-12: When `countEquals` or `absent` uses a positioned locator, the parser shall reject it with `position_not_allowed`. On a fixture page with three matching buttons, `first`, `last` and `2` shall act on the expected button, and `4` shall return `not-found` with nothing dispatched (oracle: specified).
- AC-SPEC-30-13: When a `testId` locator names an attribute the project does not declare, the parser shall reject it with `unknown_value`. A project attribute outside the allowed pattern shall fail project parsing. A test id holding selector syntax (`"]`, `*`, `,`, `\`) shall match only an element whose attribute equals that exact text, and on a fixture page with look-alike elements nothing shall be dispatched (oracle: specified).
- AC-SPEC-30-14: When `press` has a repeated modifier, more than four modifiers or an unknown one, the parser shall reject it with `duplicate`, `too_large` or `unknown_value`. The driver shall press the modifiers down in order, then the key, then release them in reverse. `ControlOrMeta` shall become Control on the Linux targets (oracle: specified; a fixture page records key events).
- AC-SPEC-30-15: When a plan presses Control+Enter or Shift+Enter in a form whose submit control matches an irreversible pattern, the runtime guard shall deny it with `irreversible-submit` and dispatch nothing (oracle: specified; extends AC-SPEC-03-07).
- AC-SPEC-30-16: When a `fill` has more lines than `maximumFillLines`, a line with a control character, or a total over `maximumFillCharacters`, the parser shall reject it with `too_large`, `unsafe_text` or `too_long`. A valid multi-line fill shall leave the field's value equal to the lines joined by "\n", with no Enter key event dispatched (oracle: specified).
- AC-SPEC-30-17: When `urlPathStartsWith` has a value not starting with "/", the parser shall reject it with `invalid_url`. Otherwise the oracle shall pass exactly when the page's path starts with the value (oracle: specified).
- AC-SPEC-30-18: When the coverage study runs, each intent's plan shall be parsed with its suite's project from `intents.json`. The report shall give the expressible share separately for the original 100 intents and for a fresh sample of at least 50, drawn by continuing the sampling rule after the 1.2 grammar is frozen and judged before any further language change (oracle: specified; extends AC-SPEC-01-01).
- AC-SPEC-30-19: When a run uses a 1.2 feature its adapter does not implement, the step shall fail with `unsupported-step`, never with a partial action. The Playwright fallback may answer `unsupported-step` for every feature in this spec (oracle: specified).
- AC-SPEC-30-20: When `contracts` and `engine` are built, neither shall have a new runtime dependency. Dates shall use Node's built-in `Intl`, whose data version is fixed by the Node version in the manifest (oracle: specified).

## Error codes

Add to SPEC-27's unions and give each a heading in `docs/errors.md`: plan codes `undefined_value` and `position_not_allowed`; the new engine union `StepErrorCode` with `value-empty`, `value-unsafe` and `value-too-long`.

## Dependencies

- SPEC-01 (parser, schema, changelog, migration), SPEC-27 (unions, `SafeText`, `Prober`), SPEC-02 (project file sections), SPEC-03 (guard rule for chords), SPEC-04 (redaction and leak scan).
- SPEC-06 implements positions, attribute matching, chords and multi-line insertion over CDP. SPEC-08 supplies the seed and clock start.
- SPEC-28 adds readable forms for the 1.2 features later; SPEC-31 to SPEC-33 extend this version.
- Research background: the coverage study (`docs/coverage-study/`); API and integration (`05` Finding 1: any escape hatch is declared in the project, never in the plan).

## Milestone

M1, straight after SPEC-04: grammar, parser, schema and changelog, value and date generation, the plan clock, project sections and the coverage-study input. Driver parts (positions, attribute matching, chords, multi-line insertion, and `remember` through `Prober`) land with SPEC-06 at M2. Until then runs report them as `unsupported-step`, as 1.1 did for its new steps.

## Satisfies

FR-01, FR-02, FR-03
