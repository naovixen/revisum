# SPEC-35: Evidence mode: a team's own Playwright suite, run and evidenced

## Purpose

The plan language fits 36% of a fresh sample of real tests (`docs/coverage-study/rerun-1.2.md`), under the 70% language-fit criterion. The founder chose the research's recorded fallback (2026-10-28, `docs/decisions/language-fit-pivot.md`): run the Playwright suites teams already have, inside the isolated runner, and wrap them with Revisum's evidence. Teams get the result file, visual report, PR comment, accessibility audit, review queue and recorded approvals without rewriting a test. It serves "AI writes features faster than we can check them" (UP-01) and "we can't prove what was tested, against which spec, or by whom" (UP-08). Revisum can't vouch for what the test code does, so every output carries the `host` guarantee level and says why. Outcome: `revisum run --suite <name>` runs a declared suite in a workload container behind the egress proxy and returns a hashed result with the same evidence as a plan run, labelled `evidence` and `host`. The safe plan path is unchanged.

## Scope and non-goals

- **In:**
  - **Enabled only in the trusted project file.** `project.json` gains an `evidenceMode` section. With no section, evidence mode is off. No CLI flag, environment variable or plan can turn it on. The section names each suite: its files, its workload image by digest, an optional setup command, the Playwright Test command, the projects to run, its environment and its limits. A person approves it like any trusted file (SPEC-02).
  - **Suite files are trusted files.** The declared suite paths join SPEC-02's trusted files. A change that edits them, or the suite's helpers inside those paths, is run in two passes:
    - the **gating pass** runs the protected-branch version of the suite files against the change's application code;
    - the **proposal pass** runs the change's own version, when `runChangedTestsAsProposal` is true (the default). Its results are labelled `proposal` and never open the merge gate.
    - Each changed file raises a `changed-with-code` review item. An agent therefore can't make a run pass by editing the tests in the same change.
  - **A workload container**, which `runner` starts from the team's image, pinned by digest (SPEC-07 extension):
    - non-root, with the pinned seccomp profile and no cloud, production or publishing credential;
    - the repository checkout is mounted read-only. The suite writes only to an output directory Revisum owns;
    - the network has no route out except the egress proxy. Every process in the container goes through it, the suite's Node process and its browser alike. A process that ignores proxy settings can't connect, and the attempt is recorded with channel `process`. Loopback inside the container stays local, so an app the suite starts itself (Playwright's `webServer`) works;
    - the environment holds only the variables the declaration lists: literals, and secrets resolved through `SecretStore` (SPEC-04);
    - when egress can't be enforced, the run is refused with `egress-unenforceable`. Revisum never runs suite code without egress control.
  - **The command.** An argument vector, run without a shell. It must invoke Playwright Test (`playwright test`, directly or through `npx`). Revisum appends its own arguments and environment, which the declaration may not set: the JSON reporter into its output directory, traces on, `--retries=0` (a pass means a first-time pass, as in Revisum's own runs), one `--project` per declared project, and the declared timeout.
  - **Outputs decoded in `engine`.** The JSON report and every trace arrive as `unknown` or raw bytes. Hand-written decoders in `engine` parse them under size, count and depth limits:
    - `parseSuiteReport` reads the report;
    - `parseSuiteTrace` reads a trace archive with a zip reader built on `node:zlib`. It extracts nothing to disk and refuses entry names that leave the archive;
    - unsupported report or trace versions are refused with a code, never guessed.
  - **The result.** A `RunResult` (SPEC-11) with `mode: 'evidence'` and the `host` level:
    - one entry per test, with its file, title path, project, outcome, criterion ids and artefacts;
    - a failed or timed-out test becomes a `fail` finding whose steps come from the trace's actions, with the error message redacted and its location;
    - criterion ids come from Playwright annotations of type `criterion` (`test('…', { annotation: { type: 'criterion', description: 'AC-3' } }, …)`). They are labelled "linked by the suite", because the suite's code makes the link.
  - **Accessibility audit of the pages visited.** For each test, the last DOM snapshot per distinct URL in its trace is rendered in Revisum's pinned Chromium with network and scripts off. axe-core and the own engine audit it (SPEC-10). Findings name the test, the URL and `source: 'recorded-snapshot'`. Keyboard, focus and reflow probes can't run on a recorded snapshot, so each audited page raises one `needs-review` item with reason `recorded-snapshot`. Pages over `maximumAuditedPages` are listed as `walk-cap`.
  - **Captures.** The report embeds only Revisum's own masked captures of the re-rendered snapshots (SPEC-09). The suite's own screenshots are unmasked. They are kept as separate artefacts only when `keepSuiteScreenshots` is set, and are never embedded in the report or PR comment.
  - **Artefacts and leaks.** Traces are kept when `keepTraces` is set (the default). Every kept suite artefact is leak-scanned inside its archive entries (SPEC-04). An artefact with an echo of a secret is withheld, and raises a `suite-artefact-withheld` review item naming it, never the value.
  - **Report, PR comment, review queue, recorder, audit log** as for plan runs (SPEC-12 to SPEC-14). Failed tests raise `severity-unrated` items. Decisions are recorded through SPEC-13, with actors derived by SPEC-02.
  - **Manifest.** `RunManifest` gains an `evidence` record (SPEC-08):
    - the suite name and the sha256 of its sorted file list and contents;
    - the hash of the command and setup arguments, and the workload image digest;
    - the Playwright version and browser versions, marked self-reported;
    - `nonHermeticInputs` always lists `suite-code`, `suite-browser` and `app-server`.
    - Replay is not claimed: `replay` refuses an evidence manifest with `replay-not-claimed`. A rerun from the manifest is still possible.
  - **Labels on every output:** result JSON, JUnit, SARIF, job summary, report, PR comment and manifest. Each carries `mode: 'evidence'`, the `host` level and the guarantee statement: which guarantees hold and which don't (see the types below). The report banner and the PR comment's verdict line say "Evidence mode: Revisum ran your suite and recorded what it saw. It can't vouch for what the test code checks."
  - **Never counted as verified evidence.** Evidence runs never count toward `verifiedWithoutReviewShare` or `tracedCriteriaShare`, and never toward a ladder level (SPEC-21). Metrics show their counts beside, labelled. An evidence run may still fail or pass a CI job through the exit code (SPEC-11).
  - **No change to the safe path.** Plans, the plan parser, the policy gate and plan runs behave byte for byte as before. A plan run keeps `isolated` when its own conditions hold, whether or not the project enables evidence mode.
- **Non-goals:**
  - Cypress, WebdriverIO, Selenium or Capybara suites (4 of the study's 10 suites). They wait for partner demand, each with its own report decoder;
  - parsing, changing or wrapping the team's test code or Playwright config, beyond the appended arguments above;
  - live in-page auditing while the suite runs. It needs the suite to drive Revisum's browser, which ties Revisum to the suite's Playwright version. It is a later improvement, once the snapshot audit shows what it misses;
  - pinning the suite's own browser. The image digest fixes what the image holds, and the version is recorded as self-reported;
  - Revisum's Playwright plug-in for plans inside a suite (SPEC-19), which is the reverse arrangement;
  - any claim that a passing suite test is verified.

## Interfaces and types

```ts
// contracts
export type SuiteName = Brand<string, 'SuiteName'>;               // ^[a-z][a-z0-9-]{0,39}$
export type EnvironmentValue = { readonly literal: SafeText } | { readonly secretName: SecretName };
export type EvidenceSuiteDeclaration = {
  readonly name: SuiteName;
  readonly framework: 'playwright-test';                          // the only value in phase 1
  readonly paths: readonly string[];                              // repository-relative globs; trusted files (SPEC-02)
  readonly workingDirectory: string;                              // repository-relative, inside the checkout
  readonly image: ImageDigest;                                    // the team's workload image (SPEC-07)
  readonly setupCommand?: readonly string[];                      // argument vector, no shell; same egress policy
  readonly command: readonly string[];                            // must invoke Playwright Test
  readonly projects: readonly string[];                           // Playwright project names, at least one
  readonly environment: Readonly<Record<string, EnvironmentValue>>; // never a reserved name (below)
  readonly runChangedTestsAsProposal: boolean;                    // default true
  readonly keepTraces: boolean;                                   // default true
  readonly keepSuiteScreenshots: boolean;                         // default false; never embedded
  readonly timeoutMilliseconds: number;                           // default 30 min, at most 6 h
};
export type EvidenceLimits = {
  readonly maximumReportBytes: number;      // default 50 MiB
  readonly maximumTests: number;            // default 5,000
  readonly maximumTraceBytes: number;       // default 100 MiB per trace
  readonly maximumTraceEntries: number;     // default 20,000
  readonly maximumAuditedPages: number;     // default 200 per run
};
// ProjectData gains: evidenceMode?: { readonly suites: readonly EvidenceSuiteDeclaration[]; readonly limits: EvidenceLimits }
// Reserved environment names: PATH, HOME, NODE_OPTIONS, every PLAYWRIGHT_* and PW_* name, every *_PROXY name, CI and
// GITHUB_* names. Revisum sets what it needs; the declaration can't override it.

// What a run vouches for. The level is the summary: 'isolated' only when every guarantee holds.
export type GuaranteeId =
  | 'plan-closed'            // only closed, parsed plan steps acted on the page
  | 'actions-guarded'        // the policy gate's runtime guard saw every action
  | 'semantic-locators'      // elements found by role, label, text or test id
  | 'observable-checks'      // every check reads what the page shows or exposes to assistive technology
  | 'egress-enforced' | 'no-ambient-credentials' | 'secrets-redacted' | 'pii-masked'
  | 'replay-identical';
export type GuaranteeLossReason = 'evidence-mode' | 'egress-unenforceable' | UnsafeFeature;   // UnsafeFeature: SPEC-36
export type GuaranteeStatement = {
  readonly level: GuaranteeLevel;                                 // 'isolated' | 'host' (SPEC-27)
  readonly holds: readonly GuaranteeId[];
  readonly lost: readonly { readonly guarantee: GuaranteeId; readonly because: GuaranteeLossReason }[];
};
// For an evidence run: holds egress-enforced, no-ambient-credentials and secrets-redacted; loses plan-closed,
// actions-guarded, semantic-locators, observable-checks and replay-identical (all 'evidence-mode'). pii-masked holds for embedded images
// and is lost for kept suite screenshots.

export type RunMode = 'plan' | 'evidence';
export type SuiteTestOutcome = 'passed' | 'failed' | 'timed-out' | 'skipped' | 'interrupted';
export type SuiteTestId = Brand<string, 'SuiteTestId'>;           // sha256 of file, title path and project
export type SuiteTestResult = {
  readonly id: SuiteTestId; readonly file: string; readonly titlePath: readonly SafeText[]; readonly project: SafeText;
  readonly outcome: SuiteTestOutcome; readonly pass: 'gating' | 'proposal';
  readonly criterionIds: readonly CriterionId[];                  // from 'criterion' annotations; "linked by the suite"
  readonly findingIds: readonly string[];
  readonly artefacts: readonly ArtifactReference[];               // kept traces, kept suite screenshots, own masked captures
};
// RunResult (SPEC-11) gains: mode: RunMode; guarantees: GuaranteeStatement; suite?: { name: SuiteName; tests: readonly SuiteTestResult[] }
// A11yFinding (SPEC-10) gains: source?: 'live-page' | 'recorded-snapshot'
// ReviewReason (SPEC-13) gains: 'recorded-snapshot' | 'suite-artefact-withheld' | 'changed-test'
// EgressEvent channel (SPEC-07) gains: 'process'

// runner: the workload container. SPEC-36's database commands reuse it.
export type WorkloadRequest = {
  readonly image: ImageDigest; readonly argv: readonly string[]; readonly workingDirectory: string;
  readonly environment: readonly { readonly name: string; readonly value: string | Secret }[];   // revealed only in runner
  readonly policy: EgressPolicy; readonly timeoutMilliseconds: number; readonly outputDirectory: string;
};
export type WorkloadOutcome = { readonly exitCode: number; readonly timedOut: boolean; readonly egressEvents: readonly EgressEvent[] };
export interface WorkloadRunner { run(request: WorkloadRequest): Promise<Result<WorkloadOutcome, WorkloadErrorCode>> }
export type WorkloadErrorCode = 'image-missing' | 'image-digest-mismatch' | 'egress-unenforceable' | 'workload-start-failed';

// engine: pure decoders and the result builder; no I/O.
export function parseSuiteReport(input: unknown, limits: EvidenceLimits): Result<SuiteReport, readonly SuiteDecodeError[]>;
export function parseSuiteTrace(archive: Uint8Array, limits: EvidenceLimits): Result<SuiteTrace, SuiteDecodeError>;
export function evidenceResult(report: SuiteReport, traces: readonly SuiteTrace[], audits: readonly A11yFinding[],
  context: EvidenceContext): RunResult;
export type SuiteDecodeErrorCode = 'suite-report-missing' | 'suite-report-invalid' | 'suite-report-unsupported'
  | 'trace-invalid' | 'trace-unsupported' | 'too-large';
export type SuiteDecodeError = { readonly code: SuiteDecodeErrorCode; readonly path: string };   // never echoes a value
// Refusal codes (engine lifecycle) gain: 'evidence-mode-disabled' | 'suite-not-declared' | 'egress-unenforceable'.
// Run outcome codes gain: 'suite-timeout'. Replay codes (SPEC-08) gain: 'replay-not-claimed'.
// Project-file plan codes gain: 'command_not_allowed' (not a Playwright Test invocation) and 'path_not_allowed'
// (absolute, or leaving the repository); reserved environment names are 'unknown_value'.
```

**Rules the criteria rely on.**

- The JSON report's statuses map as follows: `passed` to passed; `failed` to failed; `timedOut` to timed-out; `skipped` to skipped; `interrupted` to interrupted. A run with any interrupted test is `Errored`. With `--retries=0`, Playwright's `flaky` can't occur. If a report says it did, the report is `suite-report-invalid`.
- A suite exit code that disagrees with the decoded outcomes, such as exit 0 with a failed test, makes the run `Errored`, and the result says so.
- Attachment paths in the report must resolve inside Revisum's output directory. Any other path is `suite-report-invalid` at its JSON path.
- Every free-text field from the report or a trace (titles, messages, stack lines, URLs) is `SafeText` after redaction, or it is dropped and replaced by its sha256.

## Acceptance criteria

- AC-SPEC-35-01: When `project.json` declares a suite, the project parser shall refuse it with the code and JSON path, echoing no value, when (oracle: specified; one fixture per case):
  - the image is not a `sha256:` digest (`wrong_type`);
  - the command does not invoke Playwright Test (`command_not_allowed`);
  - a path or the working directory is absolute or leaves the repository (`path_not_allowed`);
  - an environment name is reserved (`unknown_value`);
  - an environment literal is token-shaped (`literal_secret`);
  - an environment secret is undeclared (`unknown_value`).
- AC-SPEC-35-02: When a project has no `evidenceMode` section, or does not declare the named suite, `run --suite` shall be refused with `evidence-mode-disabled` or `suite-not-declared` before any container starts, and zero processes shall be started (oracle: specified).
- AC-SPEC-35-03: When the change under test adds or edits `evidenceMode` in `project.json`, the run shall use the protected-branch version and raise `changed-with-code`. A change that enables evidence mode shall therefore not run its suite until the change is approved (oracle: specified; hostile fixture repository; extends AC-SPEC-02-02).
- AC-SPEC-35-04: When the change under test edits a file in a suite's declared paths (oracle: specified):
  - the gating pass shall run the protected-branch version of every suite file;
  - the proposal pass, when enabled, shall run the change's version, label its results `proposal` and never open the merge gate;
  - each changed file shall raise a `changed-with-code` item naming it.
- AC-SPEC-35-05: When a hostile fixture suite tries to reach an undeclared origin, the proxy shall block each attempt and record an `EgressEvent` with its channel. The attempts include Node `fetch`, a raw TCP socket, browser page, WebSocket and beacon traffic, a DNS name resolving to a metadata address, and an IPv6 loopback form. No request shall reach the undeclared origin (oracle: specified; extends AC-SPEC-07-01 and AC-SPEC-07-02).
- AC-SPEC-35-06: When a fixture test prints its whole environment, the output shall hold only the declared variables and Revisum's own. No CI token, cloud credential or `GITHUB_*` value shall appear (oracle: specified; extends AC-SPEC-07-03).
- AC-SPEC-35-07: When egress can't be enforced on the host, the run shall be refused with `egress-unenforceable` and no suite code shall run (oracle: specified).
- AC-SPEC-35-08: When a fixture test fills a declared secret, writes it to standard output and puts it in its error message, the leak scan shall find no echo in raw, URI, base64, base64url, prefix or case-changed form (oracle: specified; extends AC-SPEC-04-04). It covers the result, JUnit, SARIF, report, PR comment, job summary, event log and every kept artefact's archive entries, and it shall find the planted canary. A kept trace holding the echo shall be withheld and raise `suite-artefact-withheld`.
- AC-SPEC-35-09: When `parseSuiteReport` is given a hostile report, it shall return a code and path and echo no value (oracle: specified; hostile set). The set holds wrong types, unknown statuses, nesting past the depth limit, more tests than `maximumTests`, a report over `maximumReportBytes`, `__proto__` and `constructor` keys, and attachment paths that leave the output directory. Titles holding HTML or script text shall reach the report only escaped (extends AC-SPEC-12-05).
- AC-SPEC-35-10: When `parseSuiteTrace` is given a zip bomb, an entry name holding `..` or an absolute path, more entries than `maximumTraceEntries`, a truncated archive or an unknown trace version, it shall refuse it with `too-large`, `trace-invalid` or `trace-unsupported`. Nothing shall be written outside the run's output directory (oracle: specified; hostile set).
- AC-SPEC-35-11: When a fixture report holds one test with each outcome, the result shall count them correctly. A failed or timed-out test shall become a `fail` finding with at least two steps from its trace, and the exit code shall follow `EXIT_PRECEDENCE` (oracle: specified; extends AC-SPEC-11-07). A report claiming `flaky`, or an exit code that disagrees with the outcomes, shall make the run `Errored`.
- AC-SPEC-35-12: When the suite command runs, its arguments shall include `--retries=0`, the JSON reporter into Revisum's output directory and traces on, whatever the team's config says. A declared argument of `; rm -rf /` or `$(id)` shall reach the process as literal text, with no shell (oracle: specified).
- AC-SPEC-35-13: When the suite runs past its timeout, the container shall be stopped and the run shall end `Errored` with `suite-timeout`. No unfinished test shall be reported as passed (oracle: specified).
- AC-SPEC-35-14: When a trace records pages, each distinct URL's last snapshot shall be audited by both engines with network and scripts off (oracle: specified). Findings shall carry `source: 'recorded-snapshot'`, the test id and the URL, and each audited page shall raise one `recorded-snapshot` review item. A snapshot holding `<script>`, event-handler attributes and remote images shall run no script and make zero network requests.
- AC-SPEC-35-15: When a page in a fixture trace shows seeded personal data, every image embedded in the report or attached to the PR comment shall be Revisum's masked capture, with none of the seeded values visible. Suite screenshots shall appear only as separate artefacts, and only when `keepSuiteScreenshots` is set (oracle: specified; extends AC-SPEC-12-10).
- AC-SPEC-35-16: When any output of an evidence run is generated, it shall carry `mode: 'evidence'`, `guaranteeLevel: 'host'` and the guarantee statement (oracle: specified). The outputs are result JSON, JUnit, SARIF, job summary, report, PR comment and manifest. The report banner and PR verdict line shall carry the evidence-mode sentence. The claim lint shall fail a template that applies "verified", "hermetic", "isolated" or "replayable" to an evidence run (extends AC-SPEC-17-05).
- AC-SPEC-35-17: When a fixture history mixes plan runs and evidence runs, `verifiedWithoutReviewShare`, `tracedCriteriaShare` and `levelAt` shall be computed over the plan runs only, and the evidence runs' counts shall be reported beside them (oracle: specified).
- AC-SPEC-35-18: When tests carry `criterion` annotations, their ids shall appear on the tests and findings labelled "linked by the suite" (oracle: specified). An annotation whose description is not a valid criterion id shall be dropped and raise a `spec-ambiguous` item.
- AC-SPEC-35-19: When an evidence run finishes, the manifest shall record the suite files hash, the command and setup hash, the image digest and the self-reported versions, and `nonHermeticInputs` shall list `suite-code`, `suite-browser` and `app-server` (oracle: metamorphic). Changing one byte of one suite file shall change the manifest hash, and `replay` of the manifest shall return `replay-not-claimed`.
- AC-SPEC-35-20: When a person records a decision on an evidence run's review item, it shall be recorded exactly as for a plan run (SPEC-13), with the actor derived by SPEC-02 and the `declared` label where the approval is declared (oracle: specified).
- AC-SPEC-35-21: When the project enables evidence mode, every plan-mode golden run, report and replay hash shall be byte-identical to a project without it, and plan runs shall keep their own guarantee level (oracle: regression).
- AC-SPEC-35-22: When `contracts` and `engine` are built, neither shall have a new runtime dependency. The zip reader shall use only `node:zlib`, and no package outside `cli` shall import both `engine` and `runner` (oracle: specified).

## Dependencies

- SPEC-02 (trusted files, `changed-with-code`, approval), SPEC-04 (secrets, leak scan), SPEC-07 (container, egress proxy, resolve-time check; the workload runner extends it), SPEC-08 (manifest), SPEC-09 (masking), SPEC-10 (audit), SPEC-11 (result, exit codes), SPEC-12 (report, PR comment), SPEC-13 (review queue, recorder), SPEC-14 (audit log), SPEC-16 (`run --suite`), SPEC-17 (claim lint), SPEC-27 (unions, `GuaranteeLevel`).
- **No suite code runs before SPEC-07's criteria 01 to 04 and 06 pass.** Everything in M1 below runs on fixture reports and traces only.
- Research background: the MVP plan's language-fit response, "pivot to evidence mode around existing Playwright tests" at the `host` level (`09` §6), and the guarantee table, where `host` keeps only some guarantees (`04` Finding 1).

## Milestone

- **M1 (no containers):** the `evidenceMode` project section and its parser rules; suite paths as trusted files; `parseSuiteReport`; `evidenceResult`; `GuaranteeStatement` and the labels in the result. All tested on fixture reports (criteria 01 to 04, 09, 11, 16 for the result, 17, 18, 21, 22).
- **M2, after SPEC-07 and with SPEC-08:** the workload runner, egress and environment for the suite, the command, timeouts, `parseSuiteTrace`, the manifest's `evidence` record and `replay-not-claimed` (criteria 05 to 08, 10, 12, 13, 19).
- **M3, with SPEC-09 to SPEC-14:** the recorded-snapshot audit, masked captures, report, PR comment, review queue, recorder and leak scan of kept artefacts (criteria 08 in full, 14, 15, 16, 20).
- **M4, with SPEC-16 and SPEC-17:** `revisum run --suite <name>`, the Action's `suites` input, `doctor` checks (image missing, egress blocked, report missing) and the claim lint wording.

## Satisfies

Founder decision 2026-10-28 (`docs/decisions/language-fit-pivot.md`); no requirement id fits. It builds on FR-10 to FR-17 and NFR-03 and NFR-04.
