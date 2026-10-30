# SPEC-34: Advancing the clock and checking the clipboard

## Purpose

Two kinds of test in the coverage study could not be written in plan 1.2. Some need time to pass: a session that expires, an autosave timer, a debounce. Their frameworks slept or faked timers with page scripts. Others check what a "Copy" button put on the clipboard, by reading `navigator.clipboard` from a page script. This spec adds both as closed, typed plan data. `advanceClock` moves the run's virtual clock forward by a declared, bounded amount, firing the page's due timers in a fixed order, with no real waiting. `expectClipboard` and a clipboard source for `remember` read the text the page copied, from a clipboard that lives only inside the run's browser. It serves "our end-to-end tests are flaky, so nobody trusts a red build" (UP-02): time-dependent behaviour becomes deterministic instead of a sleep. It also serves "AI writes features faster than we can check them" (UP-01): copy features become evidence instead of hand-run steps. Outcome: plan 1.2 (owned by SPEC-30) gains these steps. Plans still hold no script, sleep or regular expression, and replay stays byte-identical.

## Scope and non-goals

- **In:**
  - **Advancing the clock.** A step `advanceClock` takes a whole amount and a unit, from milliseconds to days. A day is 86,400,000 ms of elapsed time; wall-clock dates follow from the new instant in the target's time zone, so a daylight-saving change needs no special case.
    - The page's `Date` and `performance.now()` move forward by exactly the amount.
    - In the default mode, `runTimers`, every page timer due within the amount fires before the step ends, at its own virtual time. Timers fire in due-time order; ties go in scheduling order. Intervals repeat. Timers that the fired callbacks schedule also fire if they come due within the amount. Promise jobs run between timers. Animation-frame callbacks run once per 16 ms of virtual time while any are pending.
    - In `skipAhead` mode the clock jumps, then each timer that is now due fires once, intervals included, as after a computer wakes from sleep.
    - Timers not yet due keep their remaining delay, shortened by the amount.
    - Each advance fires at most `maximumTimersPerAdvance` callbacks. Beyond that the step fails with `clock-runaway`, so a timer loop cannot hang a run.
    - The amount is bounded per step (`maximumClockAdvanceMilliseconds`) and per plan (`maximumTotalClockAdvanceMilliseconds`). Plans are straight-line, so the parser checks the total.
    - One run has one virtual time. An advance moves every frame of the session and an open `newTab` (SPEC-31). Documents loaded later start at the advanced time, so page time never goes backwards.
  - **Clipboard checks.** A step `expectClipboard` checks the clipboard's plain text: `textEquals`, `textContains` or `textExcludes`, against literal text, a run value (SPEC-30) or, for `textEquals`, multi-line text. Like `expect`, it retries until it passes or the step times out, because copying is asynchronous.
  - **Remembering clipboard text.** `remember` gains the source `{ clipboard: 'text' }`. The value is page content and follows SPEC-30's remembered-value rules: checked at read time against the `SafeText` rules and the length limit, then recorded only by name and sha256. Multi-line text therefore fails `value-unsafe`; check it with `expectClipboard` instead.
  - **A run-local clipboard.** The clipboard is the headless browser's own in-memory clipboard. It starts empty for every session and is never the host's clipboard. The page gets no clipboard-read permission except during the driver's own read.
- **Non-goals:**
  - writing to the clipboard from a plan, and paste steps. Neither is needed by any sampled intent. A plan-written clipboard would be a second text-input channel beside `fill`, with none of the policy guard's view of controls;
  - clipboard formats other than plain text: HTML, images and files;
  - moving the clock backwards, setting it to an absolute time mid-run, or pausing and resuming it. SPEC-30's plan clock sets the start; this spec only moves forward;
  - waiting a real amount of time. Step timeouts, auto-wait and SPEC-33's quiet window keep using real time. An advance never shortens a wait, and a wait never moves the page's clock;
  - interleaving timers across frames: each frame is advanced in turn, top document first, then frames in document order;
  - waiting for network responses during an advance. A timer that starts a request does not hold the advance. A plan that needs the response before later timers fire advances in two steps with an `expect` between them;
  - reading the clipboard on adapters that cannot keep it inside the browser. They answer `clipboard-unavailable`.

## Interfaces and types

```ts
// contracts. Plan 1.2 additions; TextOrValue, MultiLineText, ValueName and RememberSource are SPEC-30's.
export const CLOCK_UNITS = ['milliseconds', 'seconds', 'minutes', 'hours', 'days'] as const;
export type ClockUnit = (typeof CLOCK_UNITS)[number];
export type ClockAdvance = { readonly amount: number; readonly unit: ClockUnit };   // amount: a whole number, at least 1
export type ClockAdvanceMode = 'runTimers' | 'skipAhead';
export type ClipboardAssertion =
  | { readonly kind: 'textEquals'; readonly value: TextOrValue | MultiLineText }
  | { readonly kind: 'textContains' | 'textExcludes'; readonly value: TextOrValue };
// Steps added:
//  | { type: 'advanceClock'; by: ClockAdvance; mode?: ClockAdvanceMode }               // mode defaults to 'runTimers'
//  | { type: 'expectClipboard'; assert: ClipboardAssertion; criterionId: CriterionId }  // an assertion step for the vacuity rule
// RememberSource gains: | { clipboard: 'text' }
// Neither step is an ActionStep: the policy guard sees no input, and both are allowed in proposals.

// Project file additions (parser view; SPEC-02 owns the file):
//   limits.maximumClockAdvanceMilliseconds       default 3,600,000 (one hour), at most 2,678,400,000 (31 days)
//   limits.maximumTotalClockAdvanceMilliseconds  default 86,400,000 (one day), at most 2,678,400,000
//   limits.maximumTimersPerAdvance               default 10,000, at most 100,000
//   limits.maximumClipboardCharacters            default 20,000, at most 200,000

// engine. Pure.
export function clockAdvanceMilliseconds(by: ClockAdvance): number;
export function totalClockAdvanceMilliseconds(plan: Plan): number;     // sum over every advanceClock step, nested blocks included

// Driver port additions. The engine converts and bounds the amount; the driver receives milliseconds.
export interface ClockPort {
  // Moves the virtual time of every frame and tab in the session; new documents start at the new time.
  advance(milliseconds: number, mode: ClockAdvanceMode, maximumTimers: number): Promise<Result<void, DriverError>>;
}
export interface ClipboardPort {
  // Plain text of the run-local clipboard, line endings normalised to "\n", "" when empty.
  // Returns at most maximumCharacters + 1 characters, so the engine can tell when the limit was passed.
  readText(maximumCharacters: number): Promise<Result<string, DriverError>>;
}
// Session gains: clock: ClockPort; clipboard: ClipboardPort.
// DriverErrorCode additions: 'clock-runaway' | 'clipboard-unavailable'.
// determinismScript (contracts) keeps its signature. Its script gains timer tracking and the advance controller,
// and stays a trusted constant built only from integers.
```

**Rules the criteria rely on.**

- **Parsing.** A missing or non-whole `amount`, or one below 1, fails with `wrong_type`. An amount over the step limit, or the step at which the plan's total passes the plan limit, fails with `too_large`. An unknown unit, mode or assertion kind fails with `unknown_value`. Any other field fails with `unknown_field`. There is no `writeClipboard`, `paste` or `sleep` step, so each fails with `unknown_step`. Empty expected text fails with `vacuous`. Value references follow SPEC-30 (`undefined_value`).
- **Clipboard text is page content.** It is compared, never recorded. A failed check reports only "empty" or "differs". An empty clipboard fails every assertion, so `textExcludes` cannot pass on nothing. Text over `maximumClipboardCharacters` fails with `value-too-long` (SPEC-30's code). Logging goes through the redactor.
- **Clock and run values.** SPEC-30's generated dates stay relative to the run's clock start and plan clock; an advance does not change them. The manifest's `clockStartMilliseconds` is unchanged. Advance amounts are in the plan and the limits are in the project, so both are already hashed (SPEC-08). No manifest field is added.
- **The controller is no new power.** The advance controller sits in the page's main world, where the timers are. A page that reaches it can only change its own clock, which it could already do by replacing `Date` and its timers.
- **Server-rendered pages.** On a page loaded with `scripts: 'disabled'` (SPEC-31) nothing fires, but the advance still counts toward the run's virtual time.
- **Adapters.** An adapter whose target lists the clock in `nonHermeticInputs` (SPEC-08), or that cannot track timers, fails `advanceClock` with `unsupported-step`. It never falls back to a real wait.

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; `docs/decisions/answers.md`):

- **Clock limits.**
  - A single advance over the step limit is `too_large` at `.by.amount`. A huge whole number such as `1e308` is `too_large` too.
  - Going over the plan's total gives one `too_large`, at the first step that crosses it.
  - Each project limit must be at least 1, and the step limit may not exceed the total; otherwise the project is refused with `too_large` at the step limit.
- **Clipboard text.**
  - Expected multi-line text follows SPEC-30's fill limits (`maximumFillLines`, `maximumFillCharacters`).
  - `{ lines: [] }` is `empty`.
  - `pattern`, `regex` and `script` are unknown fields at `.assert.<field>`. An extra field on a clipboard source is unknown at `.from.<field>`.
- **Later specs.** When SPEC-08 adds manifest fields, AC-SPEC-34-11's pinned field list grows with them. When `Session` gains `clock` and `clipboard` (SPEC-06), the test helpers' recording driver gains them too.

## Acceptance criteria

- AC-SPEC-34-01: When a plan declaring `"1.1"` uses `advanceClock`, `expectClipboard` or a clipboard `remember` source, it shall be rejected with the code and path a 1.1 parser gives. The schema shall validate one new 1.2 golden plan per feature, and the "1.2 (unreleased)" changelog entry shall list these features and the new schema sha256 (oracle: regression; extends AC-SPEC-30-01 and AC-SPEC-30-02).
- AC-SPEC-34-02: When hostile `advanceClock` steps are parsed, the parser shall reject each with its code and path, echo no value, and cause zero driver, network or runner calls (oracle: specified; one hostile plan per case). The cases:
  - amounts of 0, -1, 1.5, `"15"` and `1e308`;
  - an unknown unit or mode;
  - an extra `script`, `sleep` or `until` field;
  - a `sleep` or `wait` step type.
- AC-SPEC-34-03: When hostile clipboard steps are parsed, the parser shall reject each with its code and path, echo no value, and cause zero driver, network or runner calls (oracle: specified; one hostile plan per case). The cases:
  - `writeClipboard`, `setClipboard` and `paste` steps (`unknown_step`);
  - a `pattern`, `regex` or `script` field (`unknown_field`);
  - script-like expected text (`unsafe_text`);
  - empty expected text (`vacuous`);
  - an undefined value reference (`undefined_value`);
  - `{ clipboard: 'html' }` (`unknown_value`).
- AC-SPEC-34-04: When a plan's advances sum to more than `maximumTotalClockAdvanceMilliseconds`, the parser shall reject it with `too_large` at the path of the step that passes the limit, counting steps inside `frame` and `newTab` blocks. A project limit outside its allowed range shall fail project parsing (oracle: specified).
- AC-SPEC-34-05: On a fixture page whose 10-minute timer shows "Session expired", advancing 9 minutes 59 seconds shall leave the text absent, and one more second shall make it visible. The page's `Date.now()` and `performance.now()` shall each have moved by exactly the sum of the advances. Each `advanceClock` step shall take under 2 seconds of real time (oracle: specified).
- AC-SPEC-34-06: On a fixture page that records callback order for timeouts at 50 and 100 ms (two at 100 ms, registered in turn), a 30 ms interval and a timeout scheduled from inside a callback, a 120 ms `runTimers` advance shall give the exact expected order and counts. A `skipAhead` advance shall fire each due timer once, the interval included (oracle: specified).
- AC-SPEC-34-07: On fixture pages with a zero-delay timer loop and an endless animation-frame loop, `runTimers` advances shall fail with `clock-runaway` within the step timeout. The run shall end `Failed` at that step, and no later step shall dispatch input (oracle: specified).
- AC-SPEC-34-08: When the interpreter runs `advanceClock` against a recording session, it shall call `ClockPort.advance` once with the amount in milliseconds and start no real timer whose delay depends on the amount (oracle: specified).
- AC-SPEC-34-09: When a plan advances the clock and then navigates, opens a `newTab` or enters a `frame`, each new document's `Date.now()` shall equal the plan clock plus every earlier advance. An advance inside a `newTab` block shall move the first tab's clock too (oracle: specified).
- AC-SPEC-34-10: When a plan with SPEC-30 date values and a plan clock advances the clock, the date values shall equal those of the same plan without advances, and the manifest's `clockStartMilliseconds` shall be the run's own (oracle: metamorphic).
- AC-SPEC-34-11: When a plan with advances and clipboard checks is replayed 20 times in the pinned Linux image, every result hash shall be identical. Changing one advance amount shall change the plan hash, and the manifest type shall gain no field (oracle: regression).
- AC-SPEC-34-12: When an adapter cannot track timers, or lists the clock as non-hermetic, `advanceClock` shall fail with `unsupported-step` and no real wait. The Playwright fallback may do so for every feature in this spec (oracle: specified).
- AC-SPEC-34-13: On a fixture page with "Copy" buttons for one-line text, multi-line text with CRLF line endings, and a copy that lands after 300 ms, `textEquals`, `textContains` and `textExcludes` shall pass and fail as expected. Multi-line `textEquals` shall compare against the lines joined by "\n". A check before any copy shall fail, `textExcludes` included (oracle: specified).
- AC-SPEC-34-14: When the page copies an invite link built from a `uniqueEmail` value, `textContains` with that value reference shall pass. When `remember` reads a copied link and a later `fill` uses it, the field shall hold the link. A clipboard `remember` shall fail on empty, multi-line and over-limit text with `value-empty`, `value-unsafe` and `value-too-long`, respectively (oracle: specified).
- AC-SPEC-34-15: When the leak scan runs over a run whose page copied a planted secret and canary personal data, it shall find no echo in the result, logs, events or report, including after a failed `expectClipboard`. A remembered clipboard value shall appear only as its name and sha256 (oracle: specified; extends AC-SPEC-04-04).
- AC-SPEC-34-16: When a canary is on the host's clipboard before a run, in the pinned Linux image and on a Windows host, the plan shall see an empty clipboard, and the canary shall still be on the host's clipboard after the page copies. A browser build that cannot keep the clipboard in memory shall make every clipboard step fail with `clipboard-unavailable` (oracle: specified; proof).
- AC-SPEC-34-17: When a fixture page's own script reads the clipboard before and after an `expectClipboard` step, both reads shall be refused (oracle: specified).
- AC-SPEC-34-18: When a plan with no approval holds `advanceClock` and `expectClipboard`, the static gate shall allow both, without `side-effect-in-proposal`. During an advance the driver shall dispatch no input event, and `guardAction` shall not be called (oracle: specified; a fixture page records input events).
- AC-SPEC-34-19: When `contracts` and `engine` are built, neither shall have a new runtime dependency (oracle: specified).

## Error codes

Add to SPEC-27's unions and give each a heading in `docs/errors.md`: driver codes `clock-runaway` and `clipboard-unavailable`. Plan and step codes are reused. Extend the headings of `too_large` (clock limits), `wrong_type` (an amount below 1) and `value-too-long` (clipboard text).

## Dependencies

- SPEC-30 (plan 1.2, `TextOrValue`, `MultiLineText`, `remember`, the plan clock, `StepErrorCode`), SPEC-31 (`newTab`, `scripts: 'disabled'`), SPEC-27 (unions, ports), SPEC-02 (project limits), SPEC-03 (static gate), SPEC-04 (redaction, leak scan).
- SPEC-08: the determinism kit gains timer tracking and the advance controller. SPEC-06 drives it:
  - `ClockPort` runs the controller in every frame's main world and re-registers the new-document script at the advanced time;
  - `ClipboardPort` grants clipboard read to the current origin only for the read (`Browser.setPermission`, reset after), reads through an isolated world, emulates focus, and clears the clipboard at session start.
- SPEC-07 (one browser per run, so the clipboard never outlives a run).
- Research background: the coverage study (`docs/coverage-study/`); `docs/decisions/plan-language-extensions.md`, founder's answer 3. This spec lifts SPEC-30's non-goal on advancing the clock and SPEC-31's on clipboard reads.

## Milestone

- **M1, straight after SPEC-33:** grammar, parser, project limits, the pure engine functions and the bullets in SPEC-30's "1.2 (unreleased)" changelog entry. They land before the coverage study is re-run, so the frozen 1.2 grammar includes them.
- **M2, with SPEC-06 and SPEC-08, after AC-SPEC-06-02:** the kit's timer tracking, `ClockPort` and `ClipboardPort`, and the host-isolation proof. Not part of the M2 alpha exit. Until then, runs report both steps as `unsupported-step`.
  - **Driver parts** (alignment, 2026-10-30). They use SPEC-30's capability model: the engine refuses a step with `unsupported-step`, with no real wait and nothing dispatched, unless the driver declares the feature in `AdapterInfo.performs`. The new features are `clockControl` and `clipboard`; the CDP driver declares both, and the Playwright fallback declares neither (AC-12). Tests that touch the host's clipboard (AC-16) save its contents first and restore them afterwards, so the founder's clipboard is never lost.

## Satisfies

FR-01, FR-02, FR-03, NFR-01, NFR-04
