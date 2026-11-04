# Error codes

## In short

- Every code of every closed error-code union has a heading here, so the link `errors#<code>` explains it.
- `npm run lint` fails, naming the code, when a code has no heading or a heading names a code no union holds (`tools/check-error-anchors.ts`).
- Plan codes use underscores (`unknown_step`); every other union uses hyphens (`not-found`).
- Each code says what was refused and what to do. Errors carry a code and a location, never the offending value, so private or hostile text is never echoed back.

Plan errors (`PlanErrorCode`, from the plan parser in `engine`) come first, then readable plan errors (`TextErrorCode`, from the readable plan reader in `engine`) and suite output errors (`SuiteDecodeErrorCode`, from the evidence-mode decoders in `engine`), then step errors (`StepErrorCode`, decided by the engine at run time), then service call errors (`ServiceCallErrorCode`, from a declared call), then driver, runner, review recorder, event sink, command-line, approval, trust, policy and run refusal errors.

## not_object

Plan error. A value that must be a JSON object is something else: an array, text, a number, `null`, or an object built from a class. Write it as a plain `{ … }` object.

## unknown_field

Plan error. An object has a field the plan language does not define. Remove the field, or check its spelling.

## missing_field

Plan error. A required field is absent, such as an assertion's `value`. Add it.

## wrong_type

Plan error. A value has the wrong JSON type, such as a number where text is expected. Use the type the plan language defines.

An `advanceClock` amount must be a whole number of at least 1: a missing amount, 0, a negative or fractional number, or text such as `"15"` is `wrong_type` at `.by.amount`.

## unknown_step

Plan error. A step's `type` is not one of the plan language's steps. Use one of the listed step types.

## unknown_value

Plan error. A value is not one of those allowed, such as an unknown role, key or audit mode, a malformed feature id, criterion id or capture name, a number out of range, or a secret name or fixture file the project does not declare. A project's `write` call declaration that lists `pendingStatuses` is refused with it too: only a backend check reads them, and it only runs a `read`.

## invalid_url

Plan error. A URL cannot be parsed, carries a user name or password, is relative without starting with `/`, or is not written as a path starting with `/` or an absolute `http://` or `https://` URL in lower case, with nothing before it. A path that starts with `//` once its dots are worked out, such as `/.//elsewhere.example/`, is also refused, because a browser would read it as another host.

## scheme_not_allowed

Plan error. A URL uses a scheme other than `http` or `https`.

## origin_not_allowed

Plan error. An absolute URL's origin is not on the project's allow-list. Use a path, or add the origin to the trusted project configuration. In the project itself: a stub's or observed request's matcher names an origin that is neither allowed nor a declared service's, or a storage entry names an origin that is not allowed.

## target_not_in_matrix

Plan error. A plan names a target the project's matrix does not declare. Nothing is substituted: declare the target, or remove it from the plan.

## unsafe_text

Plan error. Text holds control characters (C1 ones included), bidirectional marks or overrides, a zero width space, a word joiner, a byte order mark or another invisible character, U+2028 or U+2029, or something that looks like script. A person approving the plan could not read such text for what it holds. Remove them. The zero width joiner and non-joiner stay allowed, because emoji and Persian and Indic text need them, and so does the soft hyphen, which pages hold.

## too_large

Plan error. The plan is larger than the project's byte limit, nests frame steps deeper than its `maximumFrameDepth`, or has a list longer than allowed. Size and depth are checked before the plan is read, so nothing else in it is reported.

An `advanceClock` step is also `too_large` when its amount is over the project's `limits.maximumClockAdvanceMilliseconds` (reported at `.by.amount`), or when it is the step at which the plan's advances, added up in document order with those inside `frame` and `newTab` blocks, first pass `limits.maximumTotalClockAdvanceMilliseconds` (reported at the step). Split the wait over fewer, shorter advances, or raise the limits in the trusted project. A project whose step limit is above its plan limit is refused with `too_large` at `limits.maximumClockAdvanceMilliseconds`.

## too_long

Plan error. A text value is longer than allowed.

## duplicate

Plan error. A target is listed twice, two capture steps share a name, a run value is defined twice (in `values` and by a `remember` step, or by two `remember` steps), or a `press` step holds the same modifier twice. In a project, a call declaration lists a status twice in `successStatuses` or in `pendingStatuses`, or lists one in both.

## version_unsupported

Plan error. The plan's `version` is not the one this engine reads. A plan declares `"1.3"`; any other version, older or newer, is refused rather than run with parts skipped, and nothing migrates a plan to it.

## empty

Plan error. Required text or a required list is empty.

## vacuous

Plan error. A check would pass on anything, or proves nothing traceable: a plan with no assertion, an empty assertion (`assert: {}`), a text or value assertion whose expected text is blank (empty or only white space), a locator looking for blank text, a request count of `atLeast` 0, or an assertion without a `criterionId`. Give each assertion its expected text and the id of the acceptance criterion it checks.

Evidence run outcome. The suite's report holds no test that ran: it has no tests, or every test was skipped. The run says nothing about the product, so it ends `Failed` and the merge gate stays shut, whatever the exit code. Check the suite's filters and any `test.skip()`.

Evidence run outcome. The suite's report holds no tests, so the run checked nothing. It ends `Failed`, whatever the suite's exit code, and never opens the merge gate. Check the suite's paths, projects and `testMatch`.

## literal_secret

Plan error. The plan holds a secret instead of naming one: literal text filled into a field whose locator names a password, passcode, token, secret or API key (or the German or French word for one), text shaped like a credential anywhere in the plan, names and query keys included (a JSON Web Token, a `Bearer` value, or a key with a known prefix such as `ghp_`, `sk-` or `AKIA`), or saved storage state written into `storageState` itself. The error gives the path, never the text. Declare the secret's name in the project's `secretNames`, put its value in the secret store (a CI secret of the same name), and write `{ "secretName": "…" }` in the plan.

## undefined_value

Plan error. A value reference `{ "valueName": … }` names a value nothing defines before it: neither the plan's `values` nor a `remember` step earlier in the plan (inside or outside a frame). A `remember` step's own locator cannot use the name it defines. The same goes for downloads: an `expectDownload` names a download no earlier `download` step defines (inside or outside a frame or a `newTab`). The error sits on the reference and never repeats the name. Define the value or the download first, or fix the name.

## position_not_allowed

Plan error. A `countEquals` or `absent` check uses a locator with a `position`. A position picks one element of the matches, so a count of the matches would prove nothing. Remove the position, or check `visible` or `hidden` on the positioned element instead.

## misplaced_step

Plan error. A step stands where the language does not allow it: a `newTab` inside a `frame` or inside another `newTab`; a `call` or `expectBackend` inside a `frame` or a `newTab`; or any step other than `call` in the plan's `cleanup`. A second tab and a call stand only in the plan's own list of steps. The error sits on the step itself, and nothing inside it is read. Move the step to the top level of the plan.

## unsafe_interpolation

Project error. A call declaration writes a parameter where its type could change what the text says: a `text`, `email`, `boolean` or `secret` parameter, an `integer` that may be negative, or a `oneOf` with a value holding a space, a quote or a separator, inside an `$interpolate` string; or a `secret` parameter in the path or a query value, which would put it in the URL. Fill a whole JSON value with `{ "$parameter": … }` instead, or use a type that cannot hold quotes, spaces or separators (`identifier`, `integer` from 0, `yearMonthDay`, or `oneOf` of such values).

## header_not_allowed

Project error. A call declaration sets a header that decides where or how a request travels, or carries a browser session: `host`, `cookie`, `content-length`, `transfer-encoding`, `connection`, `upgrade`, `te`, `trailer` or any `proxy-` header, in any case. Remove it: the caller sets these itself, and a test credential belongs in an `authorization` header from a declared secret.

A stub response sets a header that changes how the browser treats the response: `set-cookie`, `location`, `refresh`, `content-type`, `content-length`, `transfer-encoding`, `link`, `clear-site-data`, `permissions-policy`, `strict-transport-security`, `service-worker-allowed`, `report-to`, `nel`, or any `content-security-policy`, `access-control-` or `cross-origin-` header, in any case. `x-content-type-options` is refused too: the engine always sends `nosniff` itself. Set the response's `mediaType` instead of `content-type`, and keep to plain response headers such as `cache-control` or `retry-after`.

## command_not_allowed

Project error. An evidence-mode suite's `command` does not invoke Playwright Test, or sets an argument Revisum appends itself. Write it as `["npx", "playwright", "test", …]` or `["playwright", "test", …]`, with no shell, and leave out `--reporter`, `--output`, `--trace`, `--retries`, `--project` and `--timeout`: Revisum sets the JSON reporter, traces, `--retries=0`, the declared `projects` and the declared timeout.

## path_not_allowed

Project error. An evidence-mode suite's `paths` entry or `workingDirectory` is absolute, names a drive or network share, uses a backslash, or climbs out of the repository with `..`. Write it relative to the repository root with forward slashes, such as `apps/web/e2e/**`. A declared page script's `file` must be a `.js` file under `plans/scripts/`, with no `.` or `..` segment, such as `plans/scripts/read-cart.js`.

## unsafe_feature_disabled

Plan error. A plan uses an unsafe feature its trusted `project.json` does not enable: a CSS or XPath locator (reported at the locator's `by`), a DOM check (at the assertion's `kind`, or a `remember` source's `read`), a named page script or a database command (at the step's `type`), or an inline script (at its `script.inline`). Every use is reported, and nothing under it is read or echoed. A person turns a feature on under `unsafeFeatures` in `project.json` on the protected branch; a change that turns one on in its own `project.json` runs without it until the change is approved and merged. Inline scripts need `pageScripts.allowInline: true` too. Runs using any unsafe feature are labelled unsafe and never count as verified evidence.

## unknown-statement

Readable plan error. The line is not a statement the readable grammar has, or not one that may stand there: a header after the first step, or any statement after the `Clean up:` block. Check the statement's words against the grammar in SPEC-28, or move the line.

## bad-locator

Readable plan error. A locator cannot be read: an unknown role, a position with the wrong English suffix (`2th`), or a locator kind's words misspelt. Write `<role> "<name>"`, `label "<text>"`, `text "<text>"` or `test id "<id>"`, optionally after `first`, `last` or an ordinal such as `2nd`.

## bad-string

Readable plan error. Quoted text is not closed on its line, holds an escape other than `\"` and `\\`, or a value reference is not one name in braces, such as `{orderCode}`. Close the quotes, escape quotes and backslashes only, and write references with no spaces.

## bad-indent

Readable plan error. A line is indented by anything but spaces, by an odd number of spaces, or deeper than the blocks open above it. Indent the lines of a `Values:`, `Clean up:`, `In frame …:` or `In new tab at …:` block by two spaces more than the line that opens it.

## missing-header

Readable plan error. The text has no `Plan:`, `Version:` or `Targets:` header. Add it before the first step.

## duplicate-header

Readable plan error. A header is written twice. Keep one.

## no-criterion

Readable plan error. An `Expect` line has no `Criterion:` line before it, so the check would trace to no acceptance criterion. Add `Criterion: <criterion id>` before it.

## unknown-key-name

Readable plan error. A `Press` line names a key or modifier the plan language does not have. Use a key name such as `Enter`, `a` or `Backquote`, and the modifiers `Alt`, `Control`, `Meta`, `Shift` or `ControlOrMeta`.

## too-large

Readable plan error. The text is larger than any plan may be, so none of it is read. Split the plan.

Suite output error. A suite's JSON report or trace is over one of the project's `evidenceMode.limits`: its size, its number of tests or entries, or how deeply it nests (`maximumReportDepth`, 64 unless set). Nothing in it is used. Raise the limit in the trusted project file, or split the suite. A trace is also refused over 20,000 actions, and a finding over 20,000 steps keeps only its last ones; neither limit can be raised, and each is listed in the result's `evidence.decodeErrors`.

## suite-report-missing

Suite output error. The suite command wrote no JSON report into Revisum's output directory, so there is nothing to decode. Check that the suite's config does not turn reporters off; Revisum adds the JSON reporter itself.

## suite-report-invalid

Suite output error. The suite's JSON report does not have the shape of a Playwright Test JSON report at the given path: a field of the wrong type, a status Playwright does not have, a test claiming to be `flaky` (impossible with `--retries=0`), more than one result for a test, a `__proto__`, `constructor` or `prototype` key, or an attachment path that leaves Revisum's output directory. The same code refuses a report file that is a link leading out of that directory. Nothing in the report is used, and the run is never marked verified.

## suite-report-unsupported

Suite output error. The report comes from a reporter or Playwright version Revisum does not read. Revisum refuses it rather than guess at its meaning.

## trace-invalid

Suite output error. A trace archive the suite attached is not a readable Playwright trace: it is missing, truncated, not a regular file, reached through a link leading out of Revisum's output directory, or an entry name holds `..` or an absolute path. Nothing is extracted from it.

## trace-unsupported

Suite output error. A trace archive records a trace version Revisum does not read, so it is refused rather than guessed at.

## duplicate-key

Readable plan error. A name is written twice where the plan's JSON holds it once: under `Values:`, in one argument list, in one query or in one `remembering` list. Remove or rename the second one.

## missing-unsafe-mark

Readable plan error. The line holds an unsafe construct (a CSS or XPath locator, a DOM check, remembering an attribute, a page script or a database command) but does not start with the mark `Unsafe:`. Add the mark after the line's indentation, so every reader of the plan sees it. The error is at column 1.

## unneeded-unsafe-mark

Readable plan error. The line starts with the mark `Unsafe:` but holds no unsafe construct, or is not a step line at all (a header, `Criterion:`, `Values:`, `Clean up:` or a value definition). A frame line is marked only for its own locator, never for the steps in its block. Remove the mark. The error is at column 1.

## no-readable-form

Readable plan error. The plan holds a construct the readable `.plan` format has no form for, so it is not written as text; the error gives the path of the first such construct. Every construct of plan language 1.3 has a readable form, so no plan gets this today; it is kept for a construct that reaches the language before its readable form does. Keep such a plan as JSON.

## value-empty

Step error. A run value used by the step is blank where text is needed (empty, or only white space, which any text contains, so a check against it proves nothing), or has no text yet. The step fails at run time, before anything is sent to the page, and every later step is skipped. Blank text written in a plan's check or locator is refused earlier, as `vacuous`.

## value-unsafe

Step error. A run value used by the step breaks the safe-text rules, or is `.` or `..` where a path template uses it as a segment, which would climb a segment. The step fails before any navigation or input.

## value-too-long

Step error. A run value used by the step is longer than the project's `maximumTextLength`. The step fails before anything is sent to the page. Shorten the value's prefix, or raise the limit in the trusted project.

The clipboard text an `expectClipboard` or a clipboard `remember` reads is also `value-too-long` when it is longer than the project's `limits.maximumClipboardCharacters` (20,000 unless the project sets it, at most 200,000). The text is never recorded.

## value-holds-secret

Step error. A step would have remembered a secret: its element is a field a secret was typed into, or the text it read holds one of the plan's secrets, in any form the leak scan looks for. It applies wherever the value comes from: the page, a response, the clipboard, a page script, a database command or a declared call. The step fails and every later step is skipped; a `call`, `evaluate` or `database` step also ends the run `Errored`, since a failed one could not set up the test. No value is kept and no hash of it is recorded as a remembered value, since a hash of a short secret is as good as the secret. Remember something else; a plan never needs to read a secret it was given.

## capture-left-out

Step error, on a step that passes. A `capture` took no image, because a field a secret was typed into is still on the page but its locator no longer finds it, such as when its label has changed or been removed, so it could not be masked and what it holds may still be on screen. Text drawn as pixels is out of reach of any later scan, so no image is kept rather than one that may show the secret. The step does not fail, because a capture checks nothing: the steps' verdict stands.

A field that has gone does not cause this: when the page has removed it, or its document was replaced, as after most sign-ins, there is nothing left to mask and the capture is taken as usual. The exception is a page that has rendered the field afresh under another label, still holding what was typed or part of it: no locator finds that one, so no image is kept. If you do see this code, make the field's locator still find it when the capture runs, capture before typing the secret, or type plain text into that field first.

## state-not-exposed

Step error. A state check (`selected`, `unselected`, `expanded`, `collapsed`, `pressed`, `unpressed` or `current`) targets an element that does not expose that state in the accessibility tree, for example a tab whose selection is shown only by a CSS class. The check fails rather than passes. Give the element the matching ARIA attribute (`aria-selected`, `aria-expanded`, `aria-pressed` or `aria-current`) or its native equivalent, or check another state.

## download-not-text

Step error. A content check (`contentContains` or `contentExcludes`) reads a download that is not UTF-8 text, such as an image, an archive or a PDF. Only the file's name, media type and size can be checked for such a file; use `fileNameEquals`, `mediaTypeEquals`, `sizeAtLeast` or `sizeAtMost` instead.

## request-not-seen

Step error. An `expectResponse` check, or a `remember` that reads a response field, found no exchange matching the declared request within the step timeout. Nothing is compared or remembered. Check that the page sends the request, that the declaration's matcher (origin, method, path and match) names it, and that no `resetRequests` step cleared it first.

## script-result-too-large

Step error. A page script's result, written as JSON, is larger than its `maximumResultBytes` (256 KiB unless the script's declaration sets it; an inline script always has 256 KiB). The step fails, nothing of the result is read or kept, and the run ends `Errored`: the script could not give a result to use. Return only the fields the declaration names, or raise the declaration's limit in the trusted project.

## script-result-invalid

Step and driver error. A page script's result is not JSON the run can read. The driver reports it when the result is `undefined`, a function or a symbol, or a cyclic value or one holding a bigint, which JSON cannot write. The engine reports it when the result text does not parse, or nests lists and objects deeper than 64. The step fails, nothing of the result is kept, and the run ends `Errored`. Return a plain object holding the declared fields.

## command-failed

Step error. A database command exited with a code its declaration's `successExitCodes` does not list (`[0]` unless the declaration sets them). Nothing of its output is read or kept; the result records its exit code and the sha256 of what it printed. The run ends `Errored`, later steps are skipped and cleanup still runs. A `write` command is never run again. Check the command's own log in its image, or list the exit code if it means success.

## command-timeout

Step error. A database command ran past its declaration's `timeoutMilliseconds` (60 seconds unless the declaration sets it) and its container was removed. What it printed is not read, the run ends `Errored`, later steps are skipped and cleanup still runs. A `write` command that timed out ran exactly once and is never repeated, so check the database before running the plan again. Raise the timeout in the trusted project if the command needs longer.

## command-output-invalid

Step error. A database command printed more on standard output than its declaration's `maximumOutputBytes` (1 MiB unless the declaration sets it), or, for a command whose `output` is `json`, printed something that is not exactly one JSON value: nothing, plain text or two values. Nothing of the output is read or kept, the run ends `Errored`, later steps are skipped and cleanup still runs. Print one JSON object holding the declared fields, and send logging to standard error.

## response-not-json

Service call error. A call that remembers a field, or a backend check, got a response that is not JSON: its media type is not `application/json` (or a `+json` type), or its body does not parse. A call that remembers nothing never reads the body, so any declared status passes. Check that the declaration's path reaches the API rather than a page, or drop the field.

## response-too-large

Service call error. The response is larger than the declaration's `maximumResponseBytes` (default 1 MiB). Reading stops just past the limit and the step fails, with no hash of the body. A backend check that gets a 502, 503 or 504 its declaration does not list fails with `service-unreachable` instead, however long the gateway's page. Ask the API for less, or raise the limit in the declaration.

## field-missing

Service call error. The response is JSON, but a field's JSON pointer names nothing in it, or names `null`, an object or a list where text, a number or a boolean is needed. Fix the pointer in the declaration's `fields`, or check the API's response shape.

## service-unreachable

Service call error. The caller could not connect to the declared service, or a backend check got a 502, 503 or 504, which says a gateway could not get an answer from it. Either way the run ends `Errored`: it could not test, which is not a product failure. A `call` that cannot connect ends it the same way. A backend check stops there, without waiting out its timeout or sending its read again. Cleanup still runs. Check that the service is up and its origin in `services` is right.

The step's record shows which happened: a status of 502, 503 or 504 is a gateway's answer, and no status means no connection. Declaring the status changes this. In `successStatuses` it is judged as a success. In `pendingStatuses` the check polls on it, and ends `Errored` with this code only if it is still the last status when the check timeout runs out. A `call` is not affected: it reports any status it does not count as success as `unexpected-status`.

## call-timeout

Service call error. The service did not answer within the declaration's `timeoutMilliseconds` (default 10 s). A `call` or a backend check that times out ends the run `Errored`: it could not test, which is not a product failure. The call is never sent again, whether a `write` or a backend check's read. Cleanup still runs. Raise the timeout in the declaration, or make the test API faster.

## unexpected-status

Service call error. The service answered with a status the declaration's `successStatuses` does not list. A redirect is never followed: it is judged like any other status. A `call` that gets one ends the run `Errored`, and `pendingStatuses` mean nothing to it. A backend check that gets one stops there and ends the run `Failed`, unless `pendingStatuses` lists it or it is a 502, 503 or 504 (see `service-unreachable`). Add the status to `successStatuses` if it means success, or to `pendingStatuses` on a `read` declaration if it means "not ready yet", such as a 404 until a background job finishes.

## egress-blocked

Service call error. The service's origin resolved to a private, loopback, link-local or metadata address and the service is not declared `private`, or the call names a service the run's project does not declare. Declare the service `private: true` in `services` if it really is a local test API.

## parameter-invalid

Service call error. A run value given to a call does not fit its parameter's type once its text is known: an integer that is not decimal digits or is out of range, a boolean other than `true` or `false`, an identifier, email address or day that does not match, a `oneOf` value not on the list, text over its `maximumLength`, or `""`, `.` or `..` for a path segment. No request is sent. Check the value the plan remembers or generates.

## cleanup-failed

Service call error. A cleanup call failed; its record keeps the cause. The verdict does not change, and the run raises a review item, since test data may be left behind. Clean the data up by hand, and fix the cleanup call.

## not-found

Driver error. A locator matched no element on the page. Open shadow roots count as the page, nested ones too, for every locator kind but XPath, so counts include them, and masks and the sensitive read reach them.

Two limits, where a person can see an element and a locator cannot. `absent`, `hidden` and `countEquals 0` still pass on such an element, so check it another way:

- **A closed shadow root.** In-page code cannot enter one, so only a role locator sees inside it, through the browser's accessibility engine. A label, text, test id or css locator finds nothing there, and a mask cannot reach it.
- **XPath.** An XPath expression never enters a shadow root, open or closed.

A css selector matches within one root, as it does in the browser: `.panel .error` does not match across a shadow boundary, though `.error` alone finds the element. An aria-labelledby id names an element in the same root; only an element reference set by the page's script (`ariaLabelledByElements`) can reach out of one.

## ambiguous

Driver error. A locator matched more than one element. Make it specific, for example by adding the accessible name.

## not-actionable

Driver error. The element was found but could not be acted on in time: it was hidden, disabled, covered or still moving.

## timeout

Driver error. The browser did not finish the operation within the session's time limit. An action fails with it when the browser is still handling its input after the step timeout, or the page answers nothing for that long, which is what a navigation whose server holds its answer looks like: the browser answers nothing about a page while that navigation waits. Check the server rather than the page, or raise `stepTimeoutMilliseconds` in the trusted project if the navigation is just slow.

## navigation-failed

Driver error. The browser could not load the page. An `expectPage` check fails with it too when the browser shows its own error page in place of the page, whatever the address bar says: the server refused the connection, the allow-list blocked it, or an HTTP error status came with an empty body, which Chromium also replaces with its error page, so a person would see that and not the application's page. A page that sends a body with its error status is a page that loaded.

Every check of an element on such a page fails with it too, at once, `absent`, `hidden` and `countEquals 0` included, as does a `remember` read from it: the browser's own page holds nothing of the application, so nothing can be said about what the application shows.

## policy-denied

Driver error. The policy gate's runtime guard refused the action once the driver had resolved its element, so no input event was sent. The run ends `Denied`, naming the policy rule; see that rule below. A click is judged on every attempt, by the element found, the element the pointer would hit, and the interactive element around that: a wrapper or an icon cannot lend its name to a control it holds or sits in. A driver asked to act with no guard at all refuses the same way; a run always gives one.

## no-download

Driver error. A `download` step's click started no download within the step timeout. Check that the control starts a download, or raise `stepTimeoutMilliseconds` in the trusted project.

## download-too-large

Driver error. A download grew past the project's `limits.maximumDownloadBytes` (5 MiB unless the project sets it, at most 100 MiB). The driver stopped it and deleted its partial bytes. Raise the limit in the trusted project, or download a smaller file.

## storage-origin-mismatch

Driver error. A `setStorage` or `removeStorage` step ran while the page was on another origin than the storage entry's declared `origin`, so nothing was written or removed. Navigate to a page on the entry's origin first.

## clock-runaway

Driver error. One `advanceClock` step would have fired more timer callbacks than the project's `limits.maximumTimersPerAdvance` (10,000 unless the project sets it, at most 100,000), such as a zero-delay timer loop or an endless animation-frame loop. The step fails and the run ends `Failed` there, so a timer loop cannot hang a run. Advance by less, fix the loop, or raise the limit in the trusted project.

## clipboard-unavailable

Driver error. The browser cannot keep the clipboard inside its own memory, so the driver never reads it: every `expectClipboard` and clipboard `remember` fails, and the host's clipboard is never touched. Run the plan on a target whose browser keeps a run-local clipboard.

## target-crashed

Driver error. The page's renderer died, its browser target closed, the browser died or the connection to it closed, while the step ran. The step fails, every later step is skipped, and the session still closes and ends every browser process. Run the plan again; if it keeps crashing, the page itself may exhaust the renderer's memory.

## unsupported-step

Driver error. The step made the page open a popup or a second page, or start a download no download step claimed. The popup is closed and the download cancelled, with nothing of it kept, and every later step is skipped. Change the step, or claim the file with a download step. The same code means a step named an iframe whose document runs in another process, turned scripts off inside a frame, or reached the driver still holding a value reference. A backend check whose call the run's project declares a write fails with this code too, with nothing sent: a check polls, and a write is never sent twice.

## assertion-failed

Driver error. A `dialog` step's `expectText` is not the text of the dialog the page opened, so nothing answered the dialog. Check the expected text, or the step before it that opens the dialog.

A backend check fails with it too, ending the run `Failed`, when the check timeout runs out on a field that does not pass, or on a status in `pendingStatuses` other than 502, 503 or 504. The step's record keeps the last status. A pending answer's body is never read, so raise the timeout, or check why the job did not finish.

## selector-invalid

Driver error. The browser rejects a CSS selector or XPath expression in the step's locator, or in a locator it is `inside`, or the XPath expression gives no list of nodes (such as `count(//li)`). No element can ever match, so the step fails at once, with no input sent, and every later step is skipped. Fix the selector; an XPath expression must select elements.

## script-failed

Driver error. A page script threw, its promise was rejected, or its source is not one function expression, such as `(args) => ({ count: args.limit })`. The step fails, every later step is skipped, and the run ends `Errored`: the script could not set up or check what the test needs. The error is never echoed, since it may hold page data.

## script-timeout

Driver error. A page script did not settle within its `timeoutMilliseconds` (5 seconds unless its declaration sets it), measured in real time. The step fails, every later step is skipped, and the run ends `Errored`. Make the script's promise settle, or raise the declaration's timeout in the trusted project.

## page-unreadable

Driver error. A check could not read the page: every read threw or went unanswered until the step timeout, so nothing is known about what is on it. The check fails rather than passes, `absent` and `hidden` included, because a page the run cannot read is not an empty page. Every later step is skipped. Look for page scripts that replace DOM functions such as `querySelectorAll`, a frame the page has removed, or a navigation whose server holds its answer: the browser answers nothing about a page while that navigation waits.

## dialog-open

Driver error. A check ran while an `alert`, `confirm` or `prompt` dialog held the page, so it could not be read. The check fails at once rather than passes, `absent` and `hidden` included, and every later step is skipped. Add a `dialog` step to answer the dialog before the check.

## image-missing

Runner error. The pinned container image is not available, so no browser was launched.

Workload runner error and run refusal, for an evidence run: the suite's workload image, or Revisum's own run image, is not on this host. Revisum never pulls a team's image; build or pull it yourself, then run again.

## image-digest-mismatch

Runner error. The container image's digest differs from the pinned digest, so no browser was launched.

Workload runner error and run refusal, for an evidence run: the local workload image has another id than the `image` digest the suite declares, so no suite code ran.

## egress-unenforceable

Runner log entry. Network egress cannot be enforced on this host: Docker could not create a network with no route out, or a probe from inside the run container reached an address outside. The run still starts, at the `host` guarantee level, and claims no hermetic isolation. The same entry is logged, and the runner falls to `host`, when what the proxy decided cannot be read back whole during a run.

Run refusal, for an evidence run (`run --suite`): Revisum never runs a team's own suite code without egress control, so the run is refused before any suite code runs. Run it on a host where the isolated runner can enforce egress.

## workload-start-failed

Workload runner error and run refusal, for an evidence run. The workload container did not start, or the request could not be run: a working directory outside the checkout, an empty command, a variable name no environment can hold, a path Docker cannot mount, or no Docker daemon to answer. No suite code ran. The runner's log says which.

`runSuite` also refuses with this code when the output folder holds the checkout, or when it cannot delete an earlier `report.json` or `test-results` from the folder, since a leftover could not be told from what this run writes. A setup command may have run by then. Give the suite a folder of its own whose files the host user can delete.

## start-failed

Runner error. The isolated run environment did not start, or no Docker daemon answered, which says nothing about whether the run image exists. The runner's log says which.

## rewrite-origin-not-fixture

Egress policy error. A browser mutant's response rewrite names an origin that is not a declared fixture origin. A rewrite may change only the project's own fixture apps, never the app under test or a third party, so the whole policy is refused.

## fixture-origin-undeclared

Egress policy error. A fixture origin is not among the policy's declared origins. A fixture is the project's own app, so the project must declare it. The whole policy is refused.

## fixture-origin-not-plain-http

Egress policy error. A fixture origin is not served over plain HTTP. The proxy sees only the host and port of anything else, so it could never apply a rewrite there. The whole policy is refused.

## base-image-unpinned

Run image error. `.devcontainer/devcontainer.json` names no base image pinned by digest, so the run image cannot be built from a known base.

## docker-unavailable

Run image error. The Docker client could not reach a Docker server, so the run image cannot be built.

## build-failed

Run image error. Building `packages/runner/image/Dockerfile` failed, or the built image has no id. The detail holds the end of Docker's output.

## no-reason

Review recorder error. A decision needs a reason, and none was given.

## unknown-item

Review recorder error. The decision names an item that is not in the review queue. Nothing was written.

## already-decided

Review recorder error. The item already has a recorded decision.

## sink-failed

Review recorder error. The audit event sink refused the decision's event, so the decision was not recorded.

## not-append-only

Event sink error. The audit file no longer holds exactly what the sink wrote: something else truncated or rewrote it, even if the length is unchanged. The sink refuses every later append to that file. Find out what changed it before starting a new log.

## write-failed

Event sink error. The file system refused to read or write the audit file.

## usage

Command-line error. The command line is malformed: an unknown command or flag, or a missing argument.

## config-invalid

Command-line error, and trust error from the project loader. The project configuration failed to parse. When the loader returns it, the protected-branch `project.json` exists but is not a valid project; the error lists each problem and where it is.

## untrusted-source

Command-line error, and trust error. The project configuration came from a branch other than the protected branch and has no approval, or the protected branch could not be read. Merge `project.json` to the protected branch.

Plan draft error, too. A draft claims a source only core itself records: a `core-recorded` basis, or one of core's own routes (`draft-command`, `explore-draft`, `ticket`, `builder`, `recorder`, `chat`) as a declared source. Declare `hand-written` or `customer-llm`, or declare nothing.

## plan-rejected

Command-line error. The plan parser rejected the plan. The output lists each plan error and where it is.

From `draft`: the planner's reply was not text, looked like script or was too long, so no draft was written. From `draft --explore --after`: the `--after` plan was refused by the parser or the policy gate, does not name the crawl's target, or ran and did not pass, so nothing was crawled.

## target-unavailable

Command-line error. A declared target cannot run here. Nothing is substituted.

## lock-download-failed

Command-line error. A pinned browser build could not be downloaded. The existing lockfile is left unchanged.

## lock-offline

Command-line error. Locking needed a download, but the machine is offline. The existing lockfile is left unchanged.

## approval-refused

Command-line error. The plan's approval was refused, so the plan was not run.

## replay-mismatch

Replay error, and the command-line error `replay` reports for it. A replay did not reproduce the recorded run, or what it was given does not match the manifest, so it is never a pass:

- the replay ran, but its result hash differs from the recorded one, as a `mismatch` or a `per-environment-baseline` (only the host, browser, its build, the run image, the fonts or versions differ);
- a fixture the manifest names is missing, or its sha256 differs (`fixture` names it);
- the plan does not hash to the manifest's plan hash, the target is not the manifest's, or a field of the manifest or recording has the wrong shape (`path` names it);
- a recorded reply did not match (`kind` and `position` name it): a request whose hash differs, a request after the last recorded reply, a reply never used, or no recording for a run that recorded its replies.

Nothing was sent to a declared service and no database command ran. Check the fixtures, plan and recording are the run's own.

## planner-endpoint-not-loopback

Command-line error, from `draft`. The project's `planner` is a `local` endpoint whose host is not on the loopback interface (`127.0.0.1`, `::1` or `localhost`). Nothing was sent. Serve the local model on loopback, or declare a `customer-key` endpoint over `https:`.

## planner-call-failed

Command-line error, from `draft`. The planner could not be reached, the egress proxy refused its address, it did not answer in time, its reply was over 1 MiB, or it answered with a status other than success. The error never holds the planner's reply or the key. Check the endpoint's `url`, the key's secret and the planner's own logs.

## explore-origin-refused

Command-line error, from `draft --explore`. The start URL is not on an origin the protected `project.json` declares, is on one of its `productionOrigins`, or is not an `http:` or `https:` URL. Nothing was crawled: no browser or runner started. Start from a page of a declared, non-production origin.

## after-plan-unapproved

Command-line error, from `draft --explore --after`. The plan `--after` names has no approval for its exact hash on the protected branch. Nothing was crawled: no browser or runner started. Merge the plan to the protected branch, or name one already approved.

## explore-runner-unavailable

Command-line error, from `draft --explore`. The crawl runs in the isolated runner, but there is none, it did not start, it could not enforce egress, or the crawl inside it gave no usable page map. Nothing was drafted. Start Docker and pull the pinned run image, or give `--host` to crawl in a browser on this machine, where egress is not enforced.

## explore-start-unreachable

Command-line error, from `draft --explore`. The start page did not load within the page timeout, or redirected to another origin. No page map or draft was written. Check the app is running at the start URL.

## replay-not-claimed

Replay error. No replay of this run can be claimed identical, so none is run:

- the manifest is an evidence run's: its suite code, the suite's own browser and the app server the suite starts cannot be pinned. The manifest can still be used to run the suite again;
- the target's adapter cannot pin the clock, the time zone or randomness (`nonHermeticInputs` lists them);
- the run called declared services or ran database commands, and the project did not record their replies. A replay never sends a call or runs a command again. Set `replay: { "recordReplies": true }` in the trusted `project.json` to record them; recordings may hold personal data until privacy masking (SPEC-09).

## version-unsupported

Replay error. The run manifest or recording is of a schema version this engine does not read, such as `revisum.run-manifest/v2`, is another kind of file, or holds a key this version does not know. It is refused whole rather than replayed with an input ignored. Replay it with the engine version that wrote it. Not the plan error `version_unsupported`.

## internal

Command-line error. An unexpected failure inside the tool. Please report it with the command and the run's logs.

## self-approval

Approval error. On the code-owner route, the approving reviewer opened the change, or wrote a commit in it that touches the subject. Ask a code owner who did neither, or use the agent lock-down route.

## bot-or-app

Approval error. The approving review came from a bot or app account. Such an approval is recorded as an agent's and never gates. A person must approve.

## not-code-owner

Approval error. The protected-branch code-owners file does not name the reviewer for the subject's path. A code-owners file edited in the change does not count until it is on the protected branch.

## stale-commit

Approval error. The review is on a commit older than the last commit that changed the subject, so ask for a review of the latest commit. Or, on the agent lock-down route, the proof names a commit other than the last one touching the subject on the protected branch, so land the subject through the maintainer and name that commit.

## unknown-key

Approval error. The signature's key is not registered under `signingKeys` in protected-branch `approvers.json`.

## bad-signature

Approval error. The signature could not be shown to be valid. The signed route is not built yet, so no signature verifies until it is.

## no-user-presence

Approval error. The signature was made without the user-presence flag. Sign again with a key that requires a touch.

## subject-mismatch

Approval error. The proof does not match the subject: the review is not an approval, the reviewer's latest review of that commit requests changes, the subject has no path, a plan's path resolves outside `plans/`, or the change does not touch the subject. A holdout plan is judged on `holdouts.json`, whatever path it names.

## version-control-unavailable

Approval error. GitHub could not answer a question the approval needs, or the audit sink did not record the approval. The approval is treated as absent, never as verified or declared. Try again later.

## not-maintainer

Approval error. On the agent lock-down route, the account that landed the commit is not the maintainer named in protected-branch `approvers.json`, is a bot, app or token, or is not the account the proof names.

## not-protected-branch

Approval error. On the agent lock-down route, the commit did not land on the protected default branch, or the subject as it stands there has a different hash. Merge or push it to the protected branch.

## lockdown-not-declared

Approval error. Protected-branch `approvers.json` declares no `agentLockdown`, its denied actions leave out push, merge or pull-request approval, or the agent's deny-rules file on the protected branch is missing or does not deny `git push`, `git merge` or `gh pr merge`, and `gh pr review`.

## changed-with-code

Trust error. The change under test edits a trusted file together with application code. Core ran on the protected-branch version and raised the file for review. Land the trusted-file change on its own, with an approval.

## no-approval

Trust error. A trusted file or plan has no approval of its exact hash, so it is not trusted. Get it approved; a plan with no approval runs only as a proposal.

## irreversible-action

Policy error. A click, or Enter or Space on a focused control, would press a control whose accessible name matches an irreversible pattern, such as "Delete account". The patterns are the engine's set for the target's language (delete, pay, send, revoke and their equivalents) plus the project's `policy.irreversiblePatterns`. To test such a feature, list the exact name in the trusted `policy.allowedIrreversibleNames` and get it approved.

## irreversible-submit

Policy error. Enter or Space in a field would submit a form whose submit control matches an irreversible pattern. Allow the submit control's exact name in `policy.allowedIrreversibleNames`, or change the plan.

## destructive-navigation

Policy error. A navigation, or a click on a link, would reach a URL path the project declares destructive in `policy.destructiveUrlPatterns`, or a path below it. Remove the step, or remove the path from the trusted policy if it is not destructive.

## irreversible-dialog

Policy error. The plan would accept a dialog whose text matches an irreversible pattern, such as "Revoke all API keys?". Dismiss it instead, or allow the exact text in `policy.allowedIrreversibleNames`.

## unnamed-control

Policy error. The plan would act on a control with no accessible name, which could be anything. Give the control an accessible name (its absence is an accessibility defect too), or allow its test id in `policy.unnamedControlsAllowedByTestId`, or, for a CSS or XPath locator, its exact selector or expression in `unsafeFeatures.unnamedControlsAllowed`.

## no-locale-patterns

Policy error. A target's locale has no irreversible pattern set: the engine ships English, German and French (a locale such as fr-FR uses French), and the project declares none for it. Add the locale's words to `policy.irreversiblePatterns` in the trusted project.

## undeclared-origin

Policy error. The plan navigates to an origin the trusted project does not list in `origins`, although the project it was parsed against did, or it names a call, command, stub, storage entry or page script the trusted project does not declare. Plans are held to the trusted project: add the origin or declaration there, with an approval, or change the plan.

## unsafe-feature-disabled

Policy error. The plan uses an unsafe feature that the project clearing it does not enable under `unsafeFeatures`, although the project it was parsed against did. This applies whatever the plan's standing, and nothing runs. Enable the feature in the trusted project, with an approval, or change the plan. Not the plan error `unsafe_feature_disabled`, which the parser gives.

## undeclared-secret

Policy error. The plan names a secret, in a fill, in `storageState` or as an argument, that the project clearing it does not list in `secretNames`, although the project it was parsed against did. This applies whatever the plan's standing, and nothing runs. Declare the name in the trusted project, with an approval, or change the plan.

## production-origin

Policy error. The plan navigates to an origin the trusted project marks as production. Production is denied to every plan unless the trusted `policy.allowProductionForApprovedPlans` is true, and then only to approved plans, never to a proposal. A database command whose service is on a production origin is denied to every plan, approved or not.

## over-limit

Policy error. The plan exceeds the trusted project's limits: more steps in one list than `maximumSteps`, frames nested deeper than `maximumFrameDepth`, more bytes than `maximumPlanBytes`, or more `call`, `expectBackend`, page-script and database steps, cleanup included, than `maximumCalls` (default 20). A check counts once, however often it polls. Split the plan, or raise the limit in the trusted project.

## side-effect-in-proposal

Policy error. A plan with no approval makes a `write` call, in its steps or its cleanup, whose declaration does not set `allowInProposals`; or it starts a stub, or writes or removes a storage entry, or runs a `write` page script or `write` database command (cleanup included), whose declaration does not set it. A proposal may read and may make writes the project allows in proposals, such as seeding test data; any other write waits for approval. Approve the plan, or set `allowInProposals: true` on a declaration that only touches disposable test data.

## inline-script-in-proposal

Policy error. A plan with no approval holds an inline page script: its source and its claimed effect are the plan's own, and no person declared them, so it runs only once the plan is approved. Approve the plan, or move the script into a file under `plans/scripts/` and declare it under `unsafeFeatures.pageScripts.scripts`.

## origin-not-allowed

Run refusal. The run would reach one of the project's production origins, which only an approved plan may reach, and only when the project allows production for approved plans. The refusal names the origin. No browser was opened. Not the plan error `origin_not_allowed`.

Step error, too. A `navigate` or `newTab` step's final URL is on an origin the project does not allow, so nothing was loaded and every later step is skipped. Use a path on an allowed origin, or add the origin to the trusted project configuration.

## secret-missing

Run refusal. The plan names a secret, in a fill, in `storageState` or as a call's argument, or makes a call whose declaration sends one in a header, that the secret store cannot resolve, or the run was given no secret store at all. The run ends `Refused` before any browser opens or any call is made; the refusal names the secret, never a value. Set the CI secret or environment variable of that exact name (an empty value counts as missing).

## services-unavailable

Run refusal. The plan makes a `call` or `expectBackend`, or has `cleanup` calls, but the run was given no service caller. The run ends `Refused` before any browser opens or any call is made. Run it where the service caller is wired in; until the isolated runner lands, only a caller a test supplies is available.

## storage-state-unsupported

Run refusal. The plan names saved browser storage state in `storageState`, and no driver can load it into a session yet. A plan that names it relies on being signed in, so the run ends `Refused` before any browser opens, rather than running without it. Sign in through the plan's own steps for now.

## element-check-unsupported

Run refusal. The plan checks that an element is `checked`, `unchecked` or `focused`, and no driver's probe reports those states yet, so the check could only ever fail. A plan holding one, inside a frame or a new tab too, still parses, and its run ends `Refused` before any browser opens, so no earlier step acts for nothing. Check what the state changes on the page instead, or leave the check out.

## database-commands-unavailable

Run refusal. The plan has a `database` or `expectDatabase` step, or a `database` step in its `cleanup`, but the run was given no database command runner. The run ends `Refused` before any browser opens or any command runs, so no test data is left behind. Run it where the command runner is wired in.

## script-source-missing

Run refusal. The plan names a page script whose source file the run was not given, so the manifest could not record the sha256 of what would run. The run ends `Refused` before any browser opens. The refusal names the declared file, never its content. Run it where the protected branch's `plans/scripts/` files are supplied.

## clearance-standing-mismatch

Run refusal. The policy gate cleared the plan as approved and the run has no approval of it, or the other way round. What a plan may do depends on its standing, so a clearance holds only for the standing it was decided under; a standing lent from another plan counts as none. The run ends `Refused` before any browser opens. Decide and run with the same standing.

## evidence-mode-disabled

Run refusal. `run --suite` was asked for, but the trusted project file has no `evidenceMode` section, so no suite may run and no container starts. Evidence mode is turned on only in `project.json` on the protected branch: a change that adds the section runs without it until the change is approved and merged.

## suite-timeout

Evidence run outcome. The suite, or its setup command, ran past the declared `timeoutMilliseconds` and its container was stopped. The run ends `Errored`, and any test without a final outcome is reported `interrupted`, never passed. Raise the timeout, or split the suite.

## setup-failed

Evidence run outcome. The suite's setup command exited with a non-zero code, so the suite was not run. The run ends `Errored`. Run the setup command in the workload image yourself to see why.

## suite-report-unread

Evidence run outcome. The suite's JSON report was missing or refused; the result's `evidence.decodeErrors` give each code and JSON path. The run ends `Errored`, with no tests.

Review items an evidence run can raise beside its outcome, each keeping the merge gate shut:

- `suite-output-unread`: a trace was refused, or a finding's steps were cut, so the result shows less than the suite recorded. It names its place in `evidence.decodeErrors`, which gives the code and path.
- `project-without-tests`: a project in `evidenceMode.suites[].projects` has no test in the report, so less was tested than declared. Check its name against the suite's config.

## egress-unread

Evidence run outcome. What the egress proxy decided could not be read back, or the proxy could not write all of it, such as when its `/tmp` is full. That is not the same as a proxy that blocked nothing, so the run ends `Errored` and its guarantee statement does not claim egress was enforced. Rerun, and look at what flooded the proxy if it recurs.

Plan run outcome, as a review item. The run's egress could not say what it refused, such as when an isolated run can't read its proxy's list as it closes. An empty `blockedOrigins` would claim nothing was refused, so the run ends `Errored`, whatever its steps found, and its guarantee statement does not claim egress was enforced. Each step keeps its own outcome, and the log holds why the read failed. Check that the proxy container is up, then rerun.

## suite-not-declared

Run refusal. The trusted project's `evidenceMode` section declares no suite of the name `run --suite` was given, so no container starts. Names are exact and lowercase; use one from `evidenceMode.suites[].name`.
