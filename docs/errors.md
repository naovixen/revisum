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

Plan error. A value is not one of those allowed, such as an unknown role, key or audit mode, a malformed feature id, criterion id or capture name, a number out of range, or a secret name or fixture file the project does not declare.

## invalid_url

Plan error. A URL cannot be parsed, carries a user name or password, or is relative without starting with `/`.

## scheme_not_allowed

Plan error. A URL uses a scheme other than `http` or `https`.

## origin_not_allowed

Plan error. An absolute URL's origin is not on the project's allow-list. Use a path, or add the origin to the trusted project configuration. In the project itself: a stub's or observed request's matcher names an origin that is neither allowed nor a declared service's, or a storage entry names an origin that is not allowed.

As a run refusal, the run would reach one of the project's production origins, which only an approved plan may reach, and only when the project allows production for approved plans. No browser was opened.

## target_not_in_matrix

Plan error. A plan names a target the project's matrix does not declare. Nothing is substituted: declare the target, or remove it from the plan.

## unsafe_text

Plan error. Text holds control or bidirectional-override characters, or something that looks like script. Remove them.

## too_large

Plan error. The plan is larger than the project's byte limit, nests frame steps deeper than its `maximumFrameDepth`, or has a list longer than allowed. Size and depth are checked before the plan is read, so nothing else in it is reported.

An `advanceClock` step is also `too_large` when its amount is over the project's `limits.maximumClockAdvanceMilliseconds` (reported at `.by.amount`), or when it is the step at which the plan's advances, added up in document order with those inside `frame` and `newTab` blocks, first pass `limits.maximumTotalClockAdvanceMilliseconds` (reported at the step). Split the wait over fewer, shorter advances, or raise the limits in the trusted project. A project whose step limit is above its plan limit is refused with `too_large` at `limits.maximumClockAdvanceMilliseconds`.

## too_long

Plan error. A text value is longer than allowed.

## duplicate

Plan error. A target is listed twice, two capture steps share a name, a run value is defined twice (in `values` and by a `remember` step, or by two `remember` steps), or a `press` step holds the same modifier twice.

## version_unsupported

Plan error. The plan's `version` is not one this engine reads. A current plan declares `"1.2"`, and a plan declaring `"1.1"` still parses exactly as it did. A version 1 plan is accepted only through `migratePlan`, which adds a criterion id to each assertion; a plan for a newer version is refused rather than run with parts skipped.

## empty

Plan error. Required text or a required list is empty.

## vacuous

Plan error. A check would pass on anything, or proves nothing traceable: a plan with no assertion, an empty assertion (`assert: {}`), a text or value assertion whose expected text is empty, a request count of `atLeast` 0, or an assertion without a `criterionId`. Give each assertion its expected text and the id of the acceptance criterion it checks.

## literal_secret

Plan error. The plan holds a secret instead of naming one: literal text filled into a field whose locator names a password, passcode, token, secret or API key (or the German or French word for one), text shaped like a credential anywhere in the plan (a JSON Web Token, a `Bearer` value, or a key with a known prefix such as `ghp_`, `sk-` or `AKIA`), or saved storage state written into `storageState` itself. The error gives the path, never the text. Declare the secret's name in the project's `secretNames`, put its value in the secret store (a CI secret of the same name), and write `{ "secretName": "…" }` in the plan.

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

Plan error. A plan declaring `"1.3"` uses an unsafe feature its trusted `project.json` does not enable: a CSS or XPath locator (reported at the locator's `by`), a DOM check (at the assertion's `kind`, or a `remember` source's `read`), a named page script or a database command (at the step's `type`), or an inline script (at its `script.inline`). Every use is reported, and nothing under it is read or echoed. A person turns a feature on under `unsafeFeatures` in `project.json` on the protected branch; a change that turns one on in its own `project.json` runs without it until the change is approved and merged. Inline scripts need `pageScripts.allowInline: true` too. Runs using any unsafe feature are labelled unsafe and never count as verified evidence.

## no_criterion_id

Migration error. A version 1 plan has an assertion with no entry in the criterion mapping, so the migration cannot say which acceptance criterion it checks. Add the criterion id to the mapping, keyed by the assertion step's JSON path, such as `$.steps[3]`.

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

Suite output error. A suite's JSON report or trace is over one of the project's `evidenceMode.limits`: its size, its number of tests or entries, or how deeply it nests (`maximumReportDepth`, 64 unless set). Nothing in it is used. Raise the limit in the trusted project file, or split the suite.

## suite-report-missing

Suite output error. The suite command wrote no JSON report into Revisum's output directory, so there is nothing to decode. Check that the suite's config does not turn reporters off; Revisum adds the JSON reporter itself.

## suite-report-invalid

Suite output error. The suite's JSON report does not have the shape of a Playwright Test JSON report at the given path: a field of the wrong type, a status Playwright does not have, a test claiming to be `flaky` (impossible with `--retries=0`), more than one result for a test, a `__proto__`, `constructor` or `prototype` key, or an attachment path that leaves Revisum's output directory. Nothing in the report is used, and the run is never marked verified.

## suite-report-unsupported

Suite output error. The report comes from a reporter or Playwright version Revisum does not read. Revisum refuses it rather than guess at its meaning.

## trace-invalid

Suite output error. A trace archive the suite attached is not a readable Playwright trace: it is truncated, or an entry name holds `..` or an absolute path. Nothing is extracted from it.

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

Step error. A run value used by the step is empty where text is needed, or has no text yet. The step fails at run time, before anything is sent to the page, and every later step is skipped.

## value-unsafe

Step error. A run value used by the step breaks the safe-text rules, or is `""`, `.` or `..` where a path template uses it as a segment, which would drop or climb a segment. The step fails before any navigation or input.

## value-too-long

Step error. A run value used by the step is longer than the project's `maximumTextLength`. The step fails before anything is sent to the page. Shorten the value's prefix, or raise the limit in the trusted project.

The clipboard text an `expectClipboard` or a clipboard `remember` reads is also `value-too-long` when it is longer than the project's `limits.maximumClipboardCharacters` (20,000 unless the project sets it, at most 200,000). The text is never recorded.

## state-not-exposed

Step error. A state check (`selected`, `unselected`, `expanded`, `collapsed`, `pressed`, `unpressed` or `current`) targets an element that does not expose that state in the accessibility tree, for example a tab whose selection is shown only by a CSS class. The check fails rather than passes. Give the element the matching ARIA attribute (`aria-selected`, `aria-expanded`, `aria-pressed` or `aria-current`) or its native equivalent, or check another state.

## download-not-text

Step error. A content check (`contentContains` or `contentExcludes`) reads a download that is not UTF-8 text, such as an image, an archive or a PDF. Only the file's name, media type and size can be checked for such a file; use `fileNameEquals`, `mediaTypeEquals`, `sizeAtLeast` or `sizeAtMost` instead.

## request-not-seen

Step error. An `expectResponse` check, or a `remember` that reads a response field, found no exchange matching the declared request within the step timeout. Nothing is compared or remembered. Check that the page sends the request, that the declaration's matcher (origin, method, path and match) names it, and that no `resetRequests` step cleared it first.

## response-not-json

Service call error. A call that remembers a field, or a backend check, got a response that is not JSON: its media type is not `application/json` (or a `+json` type), or its body does not parse. A call that remembers nothing never reads the body, so any declared status passes. Check that the declaration's path reaches the API rather than a page, or drop the field.

## response-too-large

Service call error. The response is larger than the declaration's `maximumResponseBytes` (default 1 MiB). Reading stops at the limit and the step fails. Ask the API for less, or raise the limit in the declaration.

## field-missing

Service call error. The response is JSON, but a field's JSON pointer names nothing in it, or names `null`, an object or a list where text, a number or a boolean is needed. Fix the pointer in the declaration's `fields`, or check the API's response shape.

## service-unreachable

Service call error. The caller could not connect to the declared service. A `call` that cannot connect ends the run `Errored`: it could not test, which is not a product failure. Cleanup still runs. Check that the service is up and its origin in `services` is right.

## call-timeout

Service call error. The service did not answer within the declaration's `timeoutMilliseconds` (default 10 s). A `write` call is never sent again. Raise the timeout in the declaration, or make the test API faster.

## unexpected-status

Service call error. The service answered with a status the declaration's `successStatuses` does not list. A redirect is never followed: it is judged like any other status. A `call` that gets one ends the run `Errored`. Add the status to `successStatuses` if it means success.

## egress-blocked

Service call error. The service's origin resolved to a private, loopback, link-local or metadata address and the service is not declared `private`, or the call names a service the run's project does not declare. Declare the service `private: true` in `services` if it really is a local test API.

## parameter-invalid

Service call error. A run value given to a call does not fit its parameter's type once its text is known: an integer that is not decimal digits or is out of range, a boolean other than `true` or `false`, an identifier, email address or day that does not match, a `oneOf` value not on the list, text over its `maximumLength`, or `""`, `.` or `..` for a path segment. No request is sent. Check the value the plan remembers or generates.

## cleanup-failed

Service call error. A cleanup call failed; its record keeps the cause. The verdict does not change, and the run raises a review item, since test data may be left behind. Clean the data up by hand, and fix the cleanup call.

## not-found

Driver error. A locator matched no element on the page.

## ambiguous

Driver error. A locator matched more than one element. Make it specific, for example by adding the accessible name.

## not-actionable

Driver error. The element was found but could not be acted on in time: it was hidden, disabled, covered or still moving.

## timeout

Driver error. The browser did not finish the operation within the session's time limit.

## navigation-failed

Driver error. The browser could not load the page.

## policy-denied

Driver error. The policy gate's runtime guard refused the action once the driver had resolved its element, so no input event was sent. The run ends `Denied`, naming the policy rule; see that rule below.

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

## image-missing

Runner error. The pinned container image is not available, so no browser was launched.

## image-digest-mismatch

Runner error. The container image's digest differs from the pinned digest, so no browser was launched.

## egress-unenforceable

Runner error. Network egress cannot be enforced on this host. The run is reported at the `host` guarantee level and claims no hermetic isolation.

Run refusal, for an evidence run (`run --suite`): Revisum never runs a team's own suite code without egress control, so the run is refused before any suite code runs. Run it on a host where the isolated runner can enforce egress.

## start-failed

Runner error. The isolated run environment did not start.

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

Plan draft error, too. A draft claims a source only core itself records: a `core-recorded` basis, or one of core's own routes (`draft-command`, `ticket`, `builder`, `recorder`, `chat`) as a declared source. Declare `hand-written` or `customer-llm`, or declare nothing.

## plan-rejected

Command-line error. The plan parser rejected the plan. The output lists each plan error and where it is.

## target-unavailable

Command-line error. A declared target cannot run here. Nothing is substituted.

## lock-download-failed

Command-line error. A pinned browser build could not be downloaded. The existing lockfile is left unchanged.

## lock-offline

Command-line error. Locking needed a download, but the machine is offline. The existing lockfile is left unchanged.

## approval-refused

Command-line error. The plan's approval was refused, so the plan was not run.

## replay-mismatch

Command-line error. Replaying a recorded run gave a different result hash from the recorded one.

## internal

Command-line error. An unexpected failure inside the tool. Please report it with the command and the run's logs.

## self-approval

Approval error. On the code-owner route, the approving reviewer opened the change, or wrote a commit in it that touches the subject. Ask a code owner who did neither, or use the agent lock-down route.

## bot-or-app

Approval error. The approving review came from a bot or app account. Such an approval is recorded as an agent's and never gates. A person must approve.

## not-code-owner

Approval error. The protected-branch code-owners file does not name the reviewer for the subject's path. A code-owners file edited in the change does not count until it is on the protected branch.

## stale-commit

Approval error. The review is on a commit older than the last commit that changed the subject. Ask for a review of the latest commit.

## unknown-key

Approval error. The signature's key is not registered under `signingKeys` in protected-branch `approvers.json`.

## bad-signature

Approval error. The signature could not be shown to be valid. The signed route is not built yet, so no signature verifies until it is.

## no-user-presence

Approval error. The signature was made without the user-presence flag. Sign again with a key that requires a touch.

## subject-mismatch

Approval error. The proof does not match the subject: the review is not an approval, the subject has no path, or the change does not touch the subject.

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

Policy error. The plan navigates to an origin the trusted project does not list in `origins`, although the project it was parsed against did. Plans are held to the trusted project: add the origin there, with an approval, or change the plan.

## production-origin

Policy error. The plan navigates to an origin the trusted project marks as production. Production is denied to every plan unless the trusted `policy.allowProductionForApprovedPlans` is true, and then only to approved plans, never to a proposal. A database command whose service is on a production origin is denied to every plan, approved or not.

## over-limit

Policy error. The plan exceeds the trusted project's limits: more steps in one list than `maximumSteps`, frames nested deeper than `maximumFrameDepth`, more bytes than `maximumPlanBytes`, or more `call`, `expectBackend`, page-script and database steps, cleanup included, than `maximumCalls` (default 20). A check counts once, however often it polls. Split the plan, or raise the limit in the trusted project.

## side-effect-in-proposal

Policy error. A plan with no approval makes a `write` call, in its steps or its cleanup, whose declaration does not set `allowInProposals`; or it starts a stub, or writes or removes a storage entry, or runs a `write` page script or `write` database command (cleanup included), whose declaration does not set it. A proposal may read and may make writes the project allows in proposals, such as seeding test data; any other write waits for approval. Approve the plan, or set `allowInProposals: true` on a declaration that only touches disposable test data.

## inline-script-in-proposal

Policy error. A plan with no approval holds an inline page script: its source and its claimed effect are the plan's own, and no person declared them, so it runs only once the plan is approved. Approve the plan, or move the script into a file under `plans/scripts/` and declare it under `unsafeFeatures.pageScripts.scripts`.

## secret-missing

Run refusal. The plan names a secret, in a fill, in `storageState` or as a call's argument, or makes a call whose declaration sends one in a header, that the secret store cannot resolve, or the run was given no secret store at all. The run ends `Refused` before any browser opens or any call is made; the refusal names the secret, never a value. Set the CI secret or environment variable of that exact name (an empty value counts as missing).

## services-unavailable

Run refusal. The plan makes a `call` or `expectBackend`, or has `cleanup` calls, but the run was given no service caller. The run ends `Refused` before any browser opens or any call is made. Run it where the service caller is wired in; until the isolated runner lands, only a caller a test supplies is available.

## script-source-missing

Run refusal. The plan names a page script whose source file the run was not given, so the manifest could not record the sha256 of what would run. The run ends `Refused` before any browser opens. The refusal names the declared file, never its content. Run it where the protected branch's `plans/scripts/` files are supplied.

## evidence-mode-disabled

Run refusal. `run --suite` was asked for, but the trusted project file has no `evidenceMode` section, so no suite may run and no container starts. Evidence mode is turned on only in `project.json` on the protected branch: a change that adds the section runs without it until the change is approved and merged.

## suite-not-declared

Run refusal. The trusted project's `evidenceMode` section declares no suite of the name `run --suite` was given, so no container starts. Names are exact and lowercase; use one from `evidenceMode.suites[].name`.
