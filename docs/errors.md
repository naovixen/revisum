# Error codes

## In short

- Every code of every closed error-code union has a heading here, so the link `errors#<code>` explains it.
- `npm run lint` fails, naming the code, when a code has no heading or a heading names a code no union holds (`tools/check-error-anchors.ts`).
- Plan codes use underscores (`unknown_step`); every other union uses hyphens (`not-found`).
- Each code says what was refused and what to do. Errors carry a code and a location, never the offending value, so private or hostile text is never echoed back.

Plan errors (`PlanErrorCode`, from the plan parser in `engine`) come first, then driver, runner, review recorder, event sink, command-line, approval and trust errors.

## not_object

Plan error. A value that must be a JSON object is something else: an array, text, a number, `null`, or an object built from a class. Write it as a plain `{ … }` object.

## unknown_field

Plan error. An object has a field the plan language does not define. Remove the field, or check its spelling.

## missing_field

Plan error. A required field is absent, such as an assertion's `value`. Add it.

## wrong_type

Plan error. A value has the wrong JSON type, such as a number where text is expected. Use the type the plan language defines.

## unknown_step

Plan error. A step's `type` is not one of the plan language's steps. Use one of the listed step types.

## unknown_value

Plan error. A value is not one of those allowed, such as an unknown role, key or audit mode, a malformed feature id, criterion id or capture name, a number out of range, or a secret name or fixture file the project does not declare.

## invalid_url

Plan error. A URL cannot be parsed, carries a user name or password, or is relative without starting with `/`.

## scheme_not_allowed

Plan error. A URL uses a scheme other than `http` or `https`.

## origin_not_allowed

Plan error. An absolute URL's origin is not on the project's allow-list. Use a path, or add the origin to the trusted project configuration.

## target_not_in_matrix

Plan error. A plan names a target the project's matrix does not declare. Nothing is substituted: declare the target, or remove it from the plan.

## unsafe_text

Plan error. Text holds control or bidirectional-override characters, or something that looks like script. Remove them.

## too_large

Plan error. The plan is larger than the project's byte limit, nests frame steps deeper than its `maximumFrameDepth`, or has a list longer than allowed. Size and depth are checked before the plan is read, so nothing else in it is reported.

## too_long

Plan error. A text value is longer than allowed.

## duplicate

Plan error. A target is listed twice, or two capture steps share a name.

## version_unsupported

Plan error. The plan's `version` is not one this engine reads. A current plan declares `"1.1"`. A version 1 plan is accepted only through `migratePlan`, which adds a criterion id to each assertion; a plan for a newer version is refused rather than run with parts skipped.

## empty

Plan error. Required text or a required list is empty.

## vacuous

Plan error. A check would pass on anything, or proves nothing traceable: a plan with no assertion, an empty assertion (`assert: {}`), a text or value assertion whose expected text is empty, or an assertion without a `criterionId`. Give each assertion its expected text and the id of the acceptance criterion it checks.

## no_criterion_id

Migration error. A version 1 plan has an assertion with no entry in the criterion mapping, so the migration cannot say which acceptance criterion it checks. Add the criterion id to the mapping, keyed by the assertion step's JSON path, such as `$.steps[3]`.

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

## image-missing

Runner error. The pinned container image is not available, so no browser was launched.

## image-digest-mismatch

Runner error. The container image's digest differs from the pinned digest, so no browser was launched.

## egress-unenforceable

Runner error. Network egress cannot be enforced on this host. The run is reported at the `host` guarantee level and claims no hermetic isolation.

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
