# Plan language changelog

Newest entry first. Each entry names the sha256 of `plan.schema.json` as it stood after the change, and `npm run lint` fails when the newest entry does not name the committed schema's hash, so the schema cannot change without an entry here. Regenerate the schema with `node tools/check-plan-schema.ts --write`, which prints the hash to record.

## 1.2 (unreleased)

Schema sha256: `7d2636db7e1f127b09fe8cca74067be2858bc15ee6b844808b395c042bbcda89`

This is the one 1.2 entry: SPEC-31, SPEC-32 and SPEC-33 add their bullets here and replace the hash above with the schema's new one. It is dated when the last of their parser parts lands.

- A plan declares `"version": "1.2"` to use the features below. A plan declaring `"1.1"` parses exactly as before: 1.1 is a subset of 1.2, and a 1.2 field or step in a `"1.1"` plan is refused with the code a 1.1 parser gives (`unknown_field`, `unknown_step`, `unknown_value` or `wrong_type`). `migratePlan` still outputs a 1.1 plan.
- **Run values.** New optional top-level `values`: named values generated for each run, from the run's seed and clock start: `uniqueText` (prefix, "-", 10 base-36 characters), `uniqueEmail` (on a domain the project declares in `generatedEmailDomains`, default `example.com`), `uniqueNumber` (4 to 12 digits) and `date` (a day relative to `today`, `startOfWeek`, `startOfMonth` or `startOfNextMonth`, in the target's time zone, written as `yearMonthDay`, `dayOfMonth`, `monthAndYear`, `longDate`, `weekday`, `timestamp` or `epochMilliseconds`).
- **Remembered values.** New step `remember`: `{ "name", "from": { "element": <locator>, "read": "text" | "value" } }`. Runs report it as `unsupported-step` until the CDP driver reads it through the prober.
- **Value references.** `{ "valueName": … }` may stand where a plan writes text for the page: fill values and lines, select options, locator names, labels, texts and test ids, text assertions' expected values, `dialog` expected text, and path-template segments and query values. Anywhere else it is refused. A reference to a value not yet defined is refused with the new plan error `undefined_value`; a name defined twice with `duplicate`.
- **Path templates.** `navigate` may take `{ "segments": […], "query": {…} }`: a path on the run's base URL, each value percent-encoded as a whole segment or query value. Literal segments holding `/`, `?` or `#` are refused (`unknown_value`), and `.` or `..` too (`invalid_url`). At run time a value of `""`, `.` or `..` fails the step with `value-unsafe` before any navigation.
- **Plan clock.** New optional top-level `clock`: `{ "day": <relative day>, "time": "HH:MM" }` sets the page's frozen clock in the target's time zone. The manifest keeps the run's own clock start.
- **Positions.** Every locator takes an optional `position`: `first`, `last` or 1 to 1000, in document order. `countEquals` and `absent` on a positioned locator are refused with the new plan error `position_not_allowed`.
- **Declared test-id attributes.** A `testId` locator may name `attribute`, one of the project's `testIdAttributes` (default `data-testid`; each `id` or `data-…`).
- **Key chords and more keys.** `press` takes optional `modifiers` (1 to 4 distinct of `Alt`, `Control`, `Meta`, `Shift`, `ControlOrMeta`). New keys: `a` to `z`, `0` to `9`, `Backquote`, `Minus`, `Equal`, `BracketLeft`, `BracketRight`, `Backslash`, `Semicolon`, `Quote`, `Comma`, `Period`, `Slash` and `F1` to `F12`. The policy gate judges Enter or Space with modifiers as without them.
- **Multi-line text.** A `fill` value may be `{ "lines": […] }`, joined with line feeds, within the project's new `limits.maximumFillLines` (default 50) and `limits.maximumFillCharacters` (default 4000, line breaks included).
- **URL prefix.** New page assertion `urlPathStartsWith`, whose value starts with `/`.
- New run-time step errors decided by the engine: `value-empty`, `value-unsafe` and `value-too-long`.
- Until the CDP driver supports them, runs report positions, test-id attributes other than `data-testid`, key chords, multi-line fills and `remember` as failed with `unsupported-step`, with nothing sent to the page.
- **Accessibility states.** New element state checks `selected`, `unselected`, `expanded`, `collapsed`, `pressed`, `unpressed` and `current`, read from the accessibility tree (`aria-selected`, `aria-expanded`, `aria-pressed`, `aria-current` and their native equivalents). An element that does not expose the state fails with the new step error `state-not-exposed`.
- **Link target.** New element assertion `hrefEquals`: literal text or a value reference, an absolute http or https URL or a path starting with `/`, compared with the link's resolved URL. The link is never followed.
- **Page metadata.** New page assertions `metaContent` (`{ "name", "value" }`: the content of the `<meta>` whose `name` or `property` is `name`; script-like names are refused with `unsafe_text`) and `canonicalUrl` (the resolved `href` of `<link rel="canonical">`, any origin, since it is compared and never visited).
- **Server-rendered view.** `navigate` takes optional `scripts`, whose only value is `"disabled"`: script execution stays off until the next `navigate`. Other text is refused with `unknown_value`, anything else with `wrong_type`.
- **Downloads.** New step `download` (`{ "name", "locator" }`): a click that must start exactly one download, guarded by the policy gate as a click. New step `expectDownload` (`{ "download", "assert", "criterionId" }`), an assertion step, with checks `fileNameEquals`, `mediaTypeEquals`, `sizeAtLeast` (at least 1; 0 is `vacuous`), `sizeAtMost`, `contentContains` and `contentExcludes`. A download name is lowercase letters, digits and hyphens (1 to 64, else `unknown_value`), defined once in the plan-wide namespace it shares with run values (`duplicate`), and checked only after its `download` step (`undefined_value`). New project settings: `maximumDownloadBytes` in `limits` (default 5 MiB, at most 100 MiB) and `keepDownloads` in a new `evidence` section (default false; download content is never kept before redaction lands). New driver errors `no-download` and `download-too-large`, and step error `download-not-text`.
- **A second tab.** New step `newTab` (`{ "url", "steps" }`): opens a URL on the allow-list, or a path template, in a new tab of the same browser context, runs its steps there and closes the tab. Only the top level of a plan may hold one; a `newTab` inside a `frame` or another `newTab` is refused with the new plan error `misplaced_step` at the step. Frame depth counts from the tab. The policy gate judges the tab's URL and steps exactly as in the first tab.
- Until the CDP driver supports them, runs report the new state checks, `hrefEquals`, `metaContent`, `canonicalUrl`, `navigate` with `scripts`, `download`, `expectDownload` and `newTab` as failed with `unsupported-step`, with nothing sent to the page.

## 1.1 (2026-10-28, secrets)

Schema sha256: `a8de4ce560a15ff02b1e6eaec657d2e4465efa825a956a5b8ef33bb15e07e6bc`

- Still `"version": "1.1"`: the change only adds an optional field, so every plan that parsed before still parses the same way, except plans holding a literal secret (below).
- New optional top-level field `storageState: { "secretName": … }`: saved browser storage state (cookies and local storage), named like any secret the project declares in `secretNames`. The secret's value is the storage-state JSON. The run records only its name and sha256; loading it into the browser session comes with the driver's session environment.
- New plan error `literal_secret`: literal text filled into a field whose locator names a password, passcode, token, secret or API key (also in German and French), credential-shaped text anywhere in the plan (a JSON Web Token, `Bearer …`, or a known key prefix such as `ghp_`, `sk-` or `AKIA`), or storage state written into the plan itself.
- Secret references in `fill` now run: the browser drivers type the resolved secret. A run whose plan names a secret the store cannot resolve is refused with `secret-missing` before any browser opens.

## 1.1 (2026-10-28)

Schema sha256: `906726f3b06796ba6c9a7e8b8745362db90d29893520e61052e92b25ed1036cb`

- First published schema. A plan declares `"version": "1.1"`.
- New steps: `hover`, `select`, `upload` (a file the project declares in `fixtures`), `frame` (steps inside an iframe, nested up to the project's `maximumFrameDepth`) and `dialog`.
- A `fill` value may be a reference `{ "secretName": … }` to a secret the project declares in `secretNames`, instead of literal text.
- New element assertions: `absent` (no element matches; `hidden` also passes for one element that is present but not shown), `checked`, `unchecked`, `focused` and `countEquals`; new page assertion `url`.
- New roles: `listbox`, `menuitem`, `table`, `row`, `cell` and `form`. New keys: `Delete`, `Home`, `End`, `PageUp` and `PageDown`.
- Every `expect` and `expectPage` step carries a `criterionId`: the acceptance criterion it checks. A plan with no assertion, an empty assertion or an assertion without a `criterionId` is rejected as `vacuous`.
- Version 1 plans are accepted for 12 months, only through `migratePlan`, which takes a criterion id for each assertion keyed by its JSON path and fails with `no_criterion_id` for any assertion left out.
- Until the browser drivers support them, runs report `hover`, `select`, `upload`, `frame` and `dialog` steps, secret references and the `checked`, `unchecked` and `focused` assertions as failed with `unsupported-step`.

## 1 (seeded)

- The seeded language: `navigate`, `click`, `fill`, `press`, `expect`, `expectPage`, `a11yAudit` and `capture`. No schema was published.
