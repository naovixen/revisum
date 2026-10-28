# Glossary

## In short

- Each domain term, the name it has in code, and where that name lives. Use these names; add a row when you add a term.
- "Planned" means the spec named in the row introduces the code name; it does not exist yet.
- Older names from the research are listed only so readers of the specs can map them. Never use them in code.

## Domain terms

| Term | Code name | Where | Meaning |
|---|---|---|---|
| Product name | `PRODUCT` (`PRODUCT.name`, `PRODUCT.schemaNamespace`) | `contracts`, exists | The only place the product name is written; schema ids are built from it |
| Engine | `engine` package | `packages/engine` | The trusted core: parsing, trust, policy, lifecycle, interpreter, oracle, hashing, redaction, audit log |
| Package | npm workspace | `packages/*` | One unit of the monorepo, with its own licence and allowed imports |
| Plan | `Plan`, made only by `planParser`; `assertBranded` checks it at run time | type in `contracts`, parser in `engine`, exists | A human-approved, typed test plan in language version 1.2 (a plan declaring 1.1 parses as it always did); outside input until the engine parses it |
| Step | `Step`, `ActionStep` | `contracts`, exists | One instruction in a plan, from a closed set: navigate, click, hover, fill, select, upload, press, frame, dialog, expect, expectPage, a11yAudit, capture, remember |
| Plan migration | `migratePlan`, `CriterionMapping` | `engine`, exists | Turns a version 1 plan into version 1.1 by adding the criterion id the author gives for each assertion, keyed by its JSON path |
| Plan schema | `planJsonSchema`, `docs/plan-language/plan.schema.json` | `engine`, exists | The published JSON Schema of the plan language, built from the parser's own tables; necessary, not sufficient |
| Secret reference | `SecretReference` (`SecretName`) | `contracts`, exists | A fill value, or a plan's `storageState`, that names a secret the project declares, instead of holding it |
| Secret | `Secret`, `createSecret`, `reveal` | `contracts`, exists | A secret's value wrapped so that printing, serialising or inspecting it gives `[secret]`; only modules in `REVEAL_ALLOWED_MODULES` (`tools/check-secret-reveal.ts`) may import `reveal` |
| Secret store | `SecretStore`, `environmentSecretStore` | port in `contracts`, environment store in `engine`, exists | Resolves a secret name to a `Secret`; the MVP reads CI secrets from environment variables of the same name. A run takes it as the optional `secrets` port |
| Literal secret | `literal_secret` | `engine`, exists | A secret written into a plan: literal text in a sensitive field, credential-shaped text, or storage state itself. The parser rejects it |
| Secret redaction | `secretRedaction`, `RedactionMode` (`value`, `key-only`), `MINIMUM_SECRET_LENGTH` | `engine` and `contracts`, exists | Removes a secret's echoes (raw, URI, base64, base64url, any case, prefixes) from kept text; secrets shorter than the minimum are redacted by key, never searched for |
| Leak scanner | `leakScanner`, `LeakScanner`, `Leak` (`LeakForm`) | port in `contracts`, scanner in `engine`, exists | Scans a run's output files, images included, for echoes of secrets; the caller plants a canary it must find |
| Saved storage state | plan `storageState`, manifest `storageState` (`StorageStateRecord`) | `contracts` and `engine`, exists | A browser's exported cookies and local storage, held as a secret; the manifest records only its name and sha256 |
| Upload fixture | `FixtureName` | `contracts`, exists | A file the project declares in its `fixtures` list, which an upload step may send. Not the app files a run serves (`FixtureReference`) |
| AI text | `AiText`, made only by `parseAiText` | `engine`, exists | Text an AI writer returned that passed the text rules; stored only as a suggestion |
| Coverage study | `assessCoverage`, `tools/coverage-study.ts` | `engine`, exists | Sampled test intents from public suites, each marked expressible in the plan language or not, with the expressible share overall and per sample (`original`, `fresh`); a suite may give its own project |
| Locator | `Locator`, `ResolvedLocator`, `literalLocator` | `contracts`, exists | How a step finds an element: by role and name, label, text or test id, optionally at a `position` (first, last or nth) and, for a test id, on a declared `attribute`. Never CSS or XPath. Resolved: every value reference replaced with its text |
| Run value | `GeneratedValue` (plan `values`), `remember` step, `ValueName`, `RunValues`, `generateValue` | `contracts` and `engine`, exists | A value a plan names and uses where it would write text: generated per run from the seed and clock start (unique text, email, number, or a date relative to the clock), or remembered from the page |
| Declared service | `DeclaredService`, `ServiceName` (project `services`) | `contracts`, parsed in `engine`, exists | A backend the trusted project names, with its origin and whether it may resolve to a private address |
| Declared call | `CallDeclaration`, `CallName`, `ParameterType`, `JsonTemplate` (project `calls`) | `contracts`, parsed in `engine`, exists | A named HTTP call a person declares in the trusted project: service, method, path, query, headers and body as templates, typed parameters, effect and response fields. A plan invokes it only by name |
| Call step, backend check, cleanup | `call`, `expectBackend` steps, plan `cleanup`, `buildServiceRequest` | `contracts` and `engine`, exists | A `call` makes a declared call and may remember response fields; an `expectBackend` checks one field of a read call, polling; `cleanup` calls run after the steps whatever the outcome |
| Service caller | `ServiceCaller`, `ServiceRequest`, `ServiceResponse` | port in `contracts`; runner's caller planned (SPEC-07) | Sends a declared call's request and reads its response. A run takes it as the optional `services` port |
| Stub | `StubDeclaration`, `StubName`, `RequestMatcher`, `STUB_MEDIA_TYPES` (project `stubs`), `stub` step | `contracts`, parsed in `engine`, exists; driver planned (SPEC-06) | A declared fake answer to the page's fetch and XHR requests that match a request matcher: responses served in order, the last repeating, data media types only and always `nosniff`. A plan starts and stops it by name |
| Observed request, request check | `ObservedRequestDeclaration`, `RequestName` (project `observedRequests`), `resetRequests`, `expectRequests`, `expectResponse` steps | `contracts`, parsed in `engine`, exists; driver planned (SPEC-06) | A declared matcher whose exchanges the driver records, so a plan may count them and check or remember fields of the latest response |
| Storage entry | `StorageEntryDeclaration`, `StorageEntryName` (project `storageEntries`), `setStorage`, `removeStorage`, `expectStorage` steps | `contracts`, parsed in `engine`, exists; driver planned (SPEC-06) | One declared local or session storage key on an allowed origin, which a plan may check, and write or remove when declared `readWrite`. Values read are compared, never recorded |
| Value reference | `ValueReference` (`{ "valueName": … }`), `TextOrValue` | `contracts`, exists | Where a plan writes text for the page, a name of a run value instead; the run substitutes it before the policy gate's runtime guard |
| Path template | `PathTemplate` (`segments`, `query`) | `contracts`, exists | A navigate URL built on the run's base URL from literal segments and value references, each value percent-encoded as a whole |
| Plan clock | `PlanClock`, `resolvePlanClock` | `contracts` and `engine`, exists | The page's frozen time, set relative to the run's clock start in the target's time zone; the manifest keeps the run's own clock start |
| Clock advance | `advanceClock` step, `ClockAdvance`, `ClockUnit`, `ClockAdvanceMode` (`runTimers`, `skipAhead`), `clockAdvanceMilliseconds`, `totalClockAdvanceMilliseconds` | `contracts` and `engine`, exists; driver planned (SPEC-06, SPEC-08) | Moves the run's virtual clock forward by a bounded whole amount, firing the page's due timers, with no real wait. Bounded per step and per plan by the project's limits |
| Clipboard check | `expectClipboard` step, `ClipboardAssertion`, `remember` from `{ "clipboard": "text" }` | `contracts`, parsed in `engine`, exists; driver planned (SPEC-06) | Checks or remembers the plain text of the run's own in-memory clipboard, never the host's. The text is compared, never recorded |
| Download | `download` step, `DownloadName`, `expectDownload` step, `DownloadAssertion` | `contracts` and `engine`, parser exists; driver planned (SPEC-31) | A click that must start exactly one file download, named for the checks after it. The file is stored under a name the driver generates, capped at `limits.maximumDownloadBytes`; its content is kept only as redacted text when `evidence.keepDownloads` is set |
| Second tab | `newTab` step | `contracts` and `engine`, parser exists; driver planned (SPEC-31) | A tab the plan opens on an allowed URL in the same browser context, so cookies and storage are shared; it runs its steps and closes. Only the plan's top level may hold one |
| Server-rendered view | `navigate` with `scripts: "disabled"`, `SCRIPT_MODES` | `contracts` and `engine`, parser exists; driver planned (SPEC-31) | A page loaded with script execution off until the next navigate, so the checks see what the server sent |
| Compared URL | `hrefEquals`, `canonicalUrl` | `engine`, parser exists | A URL a check compares and never visits: an absolute http or https URL of any origin, or a path starting with `/` |
| Key chord | press `modifiers` (`Modifier`, `ControlOrMeta`) | `contracts`, exists | Keys held down while a key is pressed; the policy gate judges Enter or Space with modifiers as without them |
| Multi-line text | `MultiLineText` (`{ "lines": […] }`), `limits.maximumFillLines`, `limits.maximumFillCharacters` | `contracts` and `engine`, exists | A fill of several lines, joined with line feeds and inserted with no Enter key press |
| Test-id attribute | `TestIdAttribute`, project `testIdAttributes` | `contracts` and `engine`, exists | An attribute (`id` or `data-…`) the project declares that a `testId` locator may match by exact equality; default `data-testid` |
| Generated email domain | `EmailDomain`, project `generatedEmailDomains` | `contracts` and `engine`, exists | A domain a generated unique email address may use; default `example.com` |
| Step error | `StepErrorCode` (`value-empty`, `value-unsafe`, `value-too-long`) | `engine`, exists | A run-time step failure the engine decides, as opposed to a driver error |
| Project | `Project`, made only by `parseProject` | `engine`, exists | The trusted, person-written configuration: allowed origins (and which are production), the target matrix, limits, the secret names and fixture files plans may refer to, and its policy (`ProjectPolicy`) |
| Target | `Target` (`TargetId`) | `contracts`, exists | One declared browser engine, device profile, locale and environment to test with. Never substituted |
| Browser driver | `BrowserDriver`, `Session` | ports in `contracts`; `cdpDriver` in `driver-cdp`, `playwrightDriver` in `driver-playwright` | Opens a session for a target; a session navigates, acts, probes, captures and audits |
| Run | `run`, `runUntrusted`, `RunResult` | `engine`, exists | Interprets a parsed plan on one target and returns a hashed result |
| Run lifecycle | `lifecycle` (`Planned`, `Resolved`, `Running`, terminal states including `Refused` and `Denied`) | `engine`, exists | The typed state machine every run walks; illegal transitions do not compile |
| Policy gate | `policyGate`, `PolicyGate` (`decide`, `guardAction`), `PolicyDecision`, `GuardVerdict`, `PolicyRuleId` | gate in `engine`, types in `contracts`, exists | Narrows what a valid plan may do: a static check before the run and a runtime guard before every action. Each denial appends a `plan.denied` audit event |
| Authorised plan | `Authorised`, made only by the policy gate; `assertAuthorised` checks it at run time | type in `contracts`, gate in `engine`, exists | A plan the policy gate cleared for its targets; the only plan `run` accepts |
| Irreversible patterns | `IrreversiblePatterns`, `BUILT_IN_IRREVERSIBLE_PATTERNS`, `policy.allowedIrreversibleNames` | `contracts` and `engine`, exists | Words per locale (delete, pay, send, revoke and project additions) that mark an action as irreversible; a locale with none is denied |
| Resolved element | `ResolvedElement`, `ActionGuard` | `contracts`, exists | What a locator resolved to on the page (name, role, form submit control, link URL), handed to the runtime guard before an action |
| Run manifest | `RunManifest`, `manifestHash` | `engine`, exists | Every input that decides a run's result, hashed, so the run can be replayed. See SPEC-08 |
| Logging manifest | `LOGGING_MANIFEST`, `manifestLogger`, `RunEventSink` | `engine`, exists | The only fields a run may log, with why and for how long; the sink a run's events go to. Not the audit `EventSink` of SPEC-27 |
| Redaction | `Redactor`, `defaultRedactor`, `SENSITIVE_PLACEHOLDER` | port in `contracts`, default in `engine`, exists | Masks personal-data elements in screenshots and personal-data patterns in kept text |
| Accessibility finding | `A11yFinding` (driver audit), `Finding` (own engine) | `contracts`, `auditor-act`, exist | One accessibility problem: a rule, its WCAG criteria, severity and the element's box |
| ACT rule, probe | `RuleMeta` with `kind: 'act-rule' \| 'probe'` | `auditor-act`, exists | A check that follows a W3C ACT rule, or a WCAG success criterion where no ACT rule exists |
| Tab walk | `tabWalk`, `TabWalk` | `auditor-act`, exists | Presses Tab through a page and records focus order, visible focus and occlusion |
| Report input | `ReportInput`, `ValidReport`, made only by `parseReportInput` | `report`, exists | The data a visual evidence report is rendered from |
| Seed provenance | `seed-provenance.json` (`SeedProvenance` shape) | repository root, exists | Where each seeded file came from: research commit, source path and SHA-256. The only file that names the research commit |
| Acceptance criterion | `criterion` (`criterionId`, `CriterionId`, `criteriaInScope`) | test metadata; on every plan assertion, exists | One observable behaviour a spec promises. Earlier name: AC |
| Change class | `changeClass` (`changeClassId`) | planned | The kind of change a pull request makes, which sets how much review it needs |
| Test set | `TEST_SET` | `tools/check-tests-apart.ts`, exists | Tests, proofs, fixtures and golden files: the paths that must change apart from code |
| Dependency review | `DependencyReview` with `DependencyCheck` items | planned, SPEC-00 | The keep-or-drop test every third-party component on the trust path must pass. Earlier name: R11 test |
| Naming lint | `NamingLintConfig`, `NAMING_LINT`, `lintRepository` | `tools/`, exists | Enforces the naming rules in CI |
| Declared approval | `DeclaredApproval`, strength `declared` | `contracts`, exists | An approval resting on the founder's own push or merge under the agent lock-down; labelled "declared, not verified" |
| Verified approval | `VerifiedApproval`, strength `verified` | `contracts`, exists | An optional approval by a code owner's review; never required. No gate, metric or level takes it (`tools/check-approval-strength.ts`) |
| Approval | `Approval`, made only by `approvalVerifier`; `approvalLabel` | type in `contracts`, verifier in `engine`, exists | A person's approval of a subject (plan, trusted file, review decision, extra review or holdout plan), keyed by its hash, with a pseudonymous approver and the proof kind |
| Approval proof | `ApprovalProof` (`code-owner-review`, `agent-lockdown-merge`, `signature`) | `contracts`, exists | The evidence offered for an approval; the verifier checks it against GitHub and the protected branch |
| Agent lock-down | `AgentLockdown`, in `approvers.json` | `contracts`, exists | The owner's route: the coding agent is denied push, merge and pull-request approval, and the named maintainer pushes and merges |
| Unverified decision | `unverified` | `engine`, exists | A decision with no usable proof: an `unverified` actor (local) or an `agent` actor (MCP, token), never an Approval |
| Version-control port | `VersionControlPort`, `VersionControlReview` | `contracts`, exists | Read-only access to GitHub: protected-branch files, reviews, pull requests and who landed a commit |
| Trusted project | `TrustedProject` (`Provenance`), made only by `loadTrustedProject` | `engine`, exists | The project read from the protected branch, with where it came from. A trusted file the change edits raises a `changed-with-code` review item |
| Trusted file | `isTrustedFile` | `engine`, exists | `project.json`, `approvers.json`, `holdouts.json`, `plans/**`, `baselines/**` and the code-owners file; everything else is application code |
| Plan standing | `PlanStanding`, `planStanding`, `approvalFor`, `mergeGateOpen` | `engine`, exists | Approved when the plan's exact hash has an approval, otherwise a proposal. A proposal never reaches `productionOrigins` and never opens the merge gate; an approved plan reaches them only when `policy.allowProductionForApprovedPlans` is true |
| Readable plan | `.plan` text; `readPlanText`, `writePlanText`, `TextErrorCode` | `engine`, exists | The plain-text form of a plan, read into plain JSON for the one plan parser and written back from a Plan; `writePlanJson` writes the canonical JSON form. See SPEC-28 |
| Plan draft | `PlanDraft` (`PlanFormat`), `admitDraft`, `DraftError` | type in `contracts`, door in `engine`, exists | What every authoring route produces: plan text, readable or JSON, never a Plan. `admitDraft` is the one door from a draft to a Plan |
| Plan provenance | `PlanProvenance` (`PlanSource`, `ProvenanceBasis`) | `contracts`, exists | Where a draft came from, recorded on its audit event and never trusted: `declared` by an author (`hand-written` or `customer-llm`), or `core-recorded` by core's own routes |
| Actor | `DerivedActor` (`ActorId`, `ActorType`), `PERSON_ACTOR_TYPES` | types in `contracts`, built only in `engine/src/actor.ts`, exists | Who an audit event is recorded against, derived by core and never declared by the caller. A person is any actor type in `PERSON_ACTOR_TYPES`; declared and verified count alike |
| Audit event sink | `EventSink`, `jsonLinesEventSink`, `EventInput`, `AuditEventKind` | port in `contracts`, sink in `engine`, exists | Append-only JSON Lines audit log; refuses to append once anything else truncated or rewrote the file. SPEC-14 adds the hash chain |
| Error code | closed unions such as `PlanErrorCode`, `DriverErrorCode`, `CliErrorCode` | `contracts` and `engine`, exists; anchors in `docs/errors.md` | A machine-readable reason from a closed set; each has a `## <code>` heading, so `errors#<code>` resolves |
| Guarantee level | `GuaranteeLevel` (`isolated`, `host`) | `contracts`, exists | How strongly a run is isolated; `host` claims no egress enforcement and no replay |
| Run history, thresholds | `RunRecord`, `Thresholds`, `ThresholdMetric` | `contracts`, exists | Finished runs as metrics see them, and the levels the maturity ladder needs |

## Metrics

| Term | Code name | Earlier name |
|---|---|---|
| Share of criteria traced to a passing test | `tracedCriteriaShare` | T |
| Share of runs that were flaky | `flakyRunRate` | F |
| Share of results verified without human review | `verifiedWithoutReviewShare` | V |
| Share of commits authored by an agent | `agentAuthoredShare` | A |
| Share of commits linked to a spec | `specLinkedShare` | S |
| Share of mutants the tests caught | `mutantsCaughtShare` | M |
| Plan approvals per change | `planApprovalsPerChange` | P |
| Share of merges without review | `unreviewedMergeShare` | U |
| Defects that escaped to users | `escapedDefects` | E |

All are planned (SPEC-00 and SPEC-15).

## Standard names

These acronyms may appear in code. Each is always the full name below.

| Acronym | Full name |
|---|---|
| ai | artificial intelligence |
| mcp | Model Context Protocol |
| sarif | Static Analysis Results Interchange Format |
| junit | JUnit XML test-report format |
| oidc | OpenID Connect |
| jwt | JSON Web Token |
| lti | Learning Tools Interoperability |

## Allowed abbreviations

id, url, uri, html, css, json, http, api, cli, ci, pr, cdp (Chrome DevTools Protocol), bidi (WebDriver BiDi), wcag (Web Content Accessibility Guidelines), act (Accessibility Conformance Testing rules), a11y (accessibility), pii (personally identifiable information), sha256, svg, png, dom, os.
