# SPEC-31: Page states, page metadata, downloads and a second tab

## Purpose

Several tests in the coverage study check what the page exposes rather than what it shows: which tab is selected, which meta tags the server sent, what a downloaded file holds, or whether a session survives in a second tab. They did it through CSS classes, raw HTML or the test framework's own page objects, none of which a closed plan may hold. This spec adds read-only checks that use the accessibility tree and the browser's own state, plus two scoped browser surfaces: a download the plan asks for and a tab the plan opens. It serves "AI writes features faster than we can check them" (UP-01) and "we can't prove what was tested, against which spec, or by whom" (UP-08): these checks become evidence instead of hand-run steps. Outcome: plan 1.2 (owned by SPEC-30) gains these steps and assertions. Popups the page opens, and downloads the plan did not ask for, still return `unsupported-step`.

## Scope and non-goals

- **In:**
  - **Accessibility states.** New element state checks: `selected`, `unselected`, `expanded`, `collapsed`, `pressed`, `unpressed` and `current`. They are read from the accessibility tree: `aria-selected`, `aria-expanded`, `aria-pressed`, `aria-current` (any value but `false`), and their native equivalents (a selected `<option>`, an open `<details>`). An element that does not expose the property fails with `state-not-exposed`, never a pass.
  - **Link target.** A new element assertion, `hrefEquals`, compares a link's resolved absolute `href`. It never follows the link.
  - **Page metadata.** New page assertions read the document head: `metaContent` (the `content` of a `<meta>` whose `name` or `property` matches) and `canonicalUrl` (the resolved `href` of `<link rel="canonical">`).
  - **Server-rendered view.** `navigate` takes an optional `scripts: 'disabled'`. The page then loads with script execution off until the next `navigate`, so head and body checks see what the server sent. Nothing runs in the page, the determinism script included.
  - **Downloads.**
    - A `download` step is a click that must start exactly one download.
    - `expectDownload` then checks its file name, media type, size, or whether its text contains or excludes a value.
    - The file is saved inside the run's container under a name the driver generates, capped at `maximumDownloadBytes`.
    - The result keeps the file's name, media type, size and sha256. The content is kept only when the project sets `evidence.keepDownloads`, and then only as redacted text (SPEC-04, SPEC-09).
    - A download started by any other step fails that step with `unsupported-step`, as AC-SPEC-06-05 requires.
  - **A second tab.** A `newTab` block opens a URL on the allow-list in a new tab of the same browser context, so cookies and storage are shared. It runs its steps there, then closes the tab. It is allowed only at the top level of the plan. Egress control, the determinism script and the policy gate apply in the new tab exactly as in the first.
- **Non-goals:**
  - CSS classes, computed styles and colours. A class-only state such as `class="active"` stays out, because reading it needs a CSS selector, and styling is covered by visual baselines (SPEC-12), not by assertions;
  - layout geometry such as overlap or position, which is pixel-dependent and varies by font and engine;
  - viewport changes during a run: a target fixes its device for the whole run (SPEC-05), so a plan declares a second target instead;
  - popups and windows the page opens itself, and switching between tabs outside a `newTab` block. These keep `unsupported-step` (SPEC-06);
  - parsing binary downloads such as images, archives or PDFs, beyond name, media type and size;
  - clipboard reads (open question in `docs/decisions/plan-language-extensions.md`).

## Interfaces and types

```ts
// contracts. Plan 1.2 additions; TextOrValue and PathTemplate are SPEC-30's.
export const ELEMENT_STATE_KINDS = ['visible', 'hidden', 'enabled', 'disabled', 'absent', 'checked', 'unchecked', 'focused',
  'selected', 'unselected', 'expanded', 'collapsed', 'pressed', 'unpressed', 'current'] as const;
// ElementAssertion gains:  | { kind: 'hrefEquals'; value: TextOrValue }      // resolved absolute href, compared as text
// PageAssertion gains:     | { kind: 'metaContent'; name: SafeText; value: TextOrValue }   // <meta name|property=…> content
//                          | { kind: 'canonicalUrl'; value: SafeText }                     // resolved <link rel="canonical"> href
export type DownloadName = Brand<string, 'DownloadName'>;          // ^[a-z0-9][a-z0-9-]{0,63}$, defined once per plan
export type DownloadAssertion =
  | { readonly kind: 'fileNameEquals'; readonly value: TextOrValue }
  | { readonly kind: 'mediaTypeEquals'; readonly value: SafeText }
  | { readonly kind: 'sizeAtMost' | 'sizeAtLeast'; readonly value: number }           // bytes; sizeAtLeast at least 1
  | { readonly kind: 'contentContains' | 'contentExcludes'; readonly value: TextOrValue }; // UTF-8 text only
// Steps added or changed:
//  | { type: 'navigate'; url: AllowedUrl | PathTemplate; scripts?: 'disabled' }
//  | { type: 'download'; name: DownloadName; locator: Locator }           // an ActionStep: the policy guard sees it as a click
//  | { type: 'expectDownload'; download: DownloadName; assert: DownloadAssertion; criterionId: CriterionId }
//  | { type: 'newTab'; url: AllowedUrl | PathTemplate; steps: readonly Step[] }   // top level only
// ActionStep gains 'download'. expectDownload is an assertion step for the vacuity rule.

// Project file additions (SPEC-02 owns the file):
//   limits.maximumDownloadBytes      default 5 MiB, at most 100 MiB
//   evidence.keepDownloads           default false

// Driver port additions (SPEC-27 style "additions"):
export type AccessibleStates = {
  readonly selected: boolean | null; readonly expanded: boolean | null;   // null: the element does not expose the property
  readonly pressed: boolean | null; readonly current: boolean | null;
};
// ElementProbe gains: states: AccessibleStates; href: string | null (resolved absolute).
// PageProbe gains:    meta: readonly { name: string; content: string }[]; canonicalUrl: string | null.
// PageNavigator.navigate gains an optional second argument: { scripts: 'enabled' | 'disabled' }.
export type DownloadedFile = { readonly fileName: string; readonly mediaType: string; readonly bytes: Uint8Array; readonly sha256: string };
// Session gains:
//   download(step: Extract<ActionStep, { type: 'download' }>, maximumBytes: number): Promise<Result<DownloadedFile, DriverError>>;
//   newTab(url: string): Promise<Result<Session, DriverError>>;   // same browser context; close() closes only the tab
// DriverErrorCode additions: 'no-download' | 'download-too-large'.
// StepErrorCode additions (SPEC-30's union): 'state-not-exposed' | 'download-not-text'.
// PlanErrorCode addition: 'misplaced_step'   // a step where the language does not allow it, such as newTab inside a frame
```

**Rules the criteria rely on.**

- A `download` name is defined by its `download` step and follows SPEC-30's definition rules: a later `expectDownload` naming an undefined download fails with `undefined_value`.
- An empty file fails every content assertion. `contentExcludes` therefore cannot pass on nothing.
- The server's file name is data. It is compared by `fileNameEquals` but never used as a path.
- `newTab` steps may contain `frame` blocks. Frame depth counts from the tab.

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; `docs/decisions/answers.md`):

- **Paths and codes.**
  - `misplaced_step` points at the step itself, `$.steps[i]`.
  - `sizeAtLeast: 0` is `vacuous`, because it passes on anything.
  - A download name that breaks the value-name rule is `unknown_value`.
  - A `scripts` field that isn't text is `wrong_type`; any text other than `"disabled"` is `unknown_value`.
- **Names.** Download names and run-value names share one plan-wide namespace, so a clash is `duplicate`. A download named inside a `newTab` or a frame stays visible after it; plans stay straight-line.
- **`hrefEquals`.** It takes an absolute URL or a path starting with `/`, compared with the link's resolved URL against the base URL. It is never visited.
- **`canonicalUrl`.** It may name another origin, because it is compared, never visited.
- **Project settings in M1.** `limits.maximumDownloadBytes` (default 5 MiB, at most 100 MiB) and `evidence.keepDownloads` (default false) are parsed now and read by the driver parts later.
- **Literal steps.** New steps and assertions go through `packages/contracts/src/literal-steps.ts`. That module decides what drivers can do yet, so runs report them as `unsupported-step` until SPEC-06, with nothing dispatched.

## Acceptance criteria

- AC-SPEC-31-01: On a fixture page with an ARIA tab list, a disclosure button, a toggle button, a navigation link with `aria-current="page"`, a `<select>` and a `<details>`, each state check shall pass on the element in that state and its opposite shall fail (oracle: specified).
- AC-SPEC-31-02: When a state check targets an element that does not expose the property, including one whose state is shown only by a CSS class, the step shall fail with `state-not-exposed`, never pass (oracle: specified).
- AC-SPEC-31-03: When `hrefEquals` checks a link with a relative `href`, the oracle shall compare the URL resolved against the page's URL, and no navigation shall occur (oracle: specified).
- AC-SPEC-31-04: On a fixture whose server HTML sets `og:title` to A and whose script changes it to B, `metaContent` after `navigate` with `scripts: 'disabled'` shall see A, and without it shall see B. A script counter in the fixture shall show that no page script ran in the first case (oracle: specified).
- AC-SPEC-31-05: When `metaContent` or `canonicalUrl` finds no matching tag, the step shall fail with `assertion-failed`. A `name` with script-like text shall be rejected at parse time with `unsafe_text` (oracle: specified).
- AC-SPEC-31-06: On a fixture serving a CSV file, `fileNameEquals`, `mediaTypeEquals`, `sizeAtLeast`, `contentContains` and `contentExcludes` shall pass and fail as expected (oracle: specified):
  - a file over `maximumDownloadBytes` shall fail with `download-too-large` and its partial bytes shall be deleted;
  - a click that starts no download within the step timeout shall fail with `no-download`;
  - a content assertion on a non-text file shall fail with `download-not-text`.
- AC-SPEC-31-07: When the server names a download `../../etc/passwd`, an absolute path or a reserved device name, the file shall be stored under a generated name inside the run's download folder, and nothing shall be written outside it (oracle: specified; proof).
- AC-SPEC-31-08: When the leak scan runs over a run that downloaded a CSV holding planted secrets and canary personal data, it shall find no echo in the result, logs or report. Only the name, media type, size and sha256 shall appear, unless `evidence.keepDownloads` is set, in which case the kept text shall pass the redactor first (oracle: specified; extends AC-SPEC-04-04).
- AC-SPEC-31-09: When a step other than `download` starts a download, or the page opens a popup, the step shall fail with `unsupported-step` and the file or popup shall be discarded (oracle: specified; keeps AC-SPEC-06-05).
- AC-SPEC-31-10: When a `download` step targets a control whose accessible name matches an irreversible pattern, the runtime guard shall deny it with `policy-denied` and dispatch nothing (oracle: specified; extends AC-SPEC-03-01).
- AC-SPEC-31-11: When a plan signs in and then opens a `newTab`, the new tab shall share the session's cookies and storage, and the tab shall be closed when the block ends, even when a step inside it fails. Its blocked origins shall join the run's `blockedOrigins()` (oracle: specified).
- AC-SPEC-31-12: When `newTab` appears inside a `frame` or another `newTab`, the parser shall reject it with `misplaced_step` and its path. When its URL's origin is not on the allow-list, it shall reject it with `origin_not_allowed`. In both cases zero driver calls shall be made (oracle: specified).
- AC-SPEC-31-13: When an `expectDownload` names a download no earlier `download` step defined, the parser shall reject it with `undefined_value` (oracle: specified).
- AC-SPEC-31-14: When the same plan with downloads and a `newTab` is replayed 20 times in the pinned Linux image, the result hashes shall be identical (oracle: regression).
- AC-SPEC-31-15: When an adapter does not implement a feature in this spec, the step shall fail with `unsupported-step`, never with a partial result. The Playwright fallback may do so for every feature here (oracle: specified).

## Error codes

Add to SPEC-27's unions and give each a heading in `docs/errors.md`: plan code `misplaced_step`; driver codes `no-download` and `download-too-large`; step codes `state-not-exposed` and `download-not-text`. Extend `undefined_value`'s heading to cover download names.

## Dependencies

- SPEC-30 (plan 1.2, `TextOrValue`, `PathTemplate`, definition rules, `StepErrorCode`), SPEC-27, SPEC-03 (guard on `download`), SPEC-04 (redaction, leak scan).
- SPEC-06: CDP accessibility tree for states; `Emulation.setScriptExecutionDisabled`; `Browser.setDownloadBehavior` and download events; `Target.createTarget` in the session's browser context. This spec pulls forward the download and second-page parts of SPEC-06's phase-2 non-goal; popups stay out.
- SPEC-07 (the download folder inside the container), SPEC-09 (masking for kept download text at M3).

## Milestone

- **M1, with SPEC-30:** grammar and parser.
- **M2, with SPEC-06:** states, `href`, metadata and the server-rendered view.
- **After SPEC-06's capability tests (AC-SPEC-06-02) and SPEC-07:** downloads and `newTab`, late in M2 or early in M3. They are not part of the M2 alpha exit.
- **Until SPEC-09 (M3):** download content is never kept, whatever `evidence.keepDownloads` says.

## Satisfies

FR-02, FR-08, NFR-04
