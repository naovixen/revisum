# SPEC-36: Unsafe plan features: opt-in escape hatches, labelled

## Purpose

The coverage study's remaining gaps are the escape hatches the closed language leaves out. They are database seeding or checks, CSS classes and computed styles, CSS-only locators, page scripts and editor data stores, and elements found only by CSS structure or record-id prefixes (`docs/coverage-study/rerun-1.2.md`). The founder chose (2026-10-28) to let a team enable them in the trusted project file, one feature at a time, and to re-measure coverage with them. It serves "AI writes features faster than we can check them" (UP-01): more real tests become plans with Revisum's evidence. It also keeps faith with "letting AI agents into our pipeline feels like handing over the keys" (UP-09). Each feature is off by default, enabled only by a person, refused by the one plan parser when disabled, and labelled `unsafe` on every output. Outcome: plan language 1.3 adds CSS and XPath locators, DOM checks, page scripts and database commands. A run that uses any of them is `host` level, says which guarantees it lost, and never counts as verified evidence.

## Scope and non-goals

- **In:**
  - **Version 1.3.** This spec owns the bump of `PLAN_VERSION` to 1.3, the schema regeneration and a "1.3 (unreleased)" changelog entry. Before opening it, the first commit dates the "1.2 (unreleased)" entry, because every 1.2 parser part has landed (SPEC-30 to SPEC-34).
    - 1.3 is 1.2 plus the features below and nothing else.
    - A plan declaring `"1.2"` or `"1.1"` parses exactly as before. An unsafe feature in it is refused with the code that version's parser gives (`unknown_value`, `unknown_field` or `unknown_step`).
    - **Why 1.3 and not 1.2:** 1.2 is the closed language the coverage study measured, and its share must stay comparable. Its features are all parsed and its entry is ready to date. The unsafe features are a different kind of addition, opt-in and weaker. A separate version keeps "1.2" meaning "closed" in every changelog, schema and study report. It also lets a reader see at a glance that a plan below 1.3 can't hold one.
  - **Six features**, each off unless the trusted `project.json` enables it under `unsafeFeatures`:
    1. `css-locator`: `{ "by": "css", "selector" }`;
    2. `xpath-locator`: `{ "by": "xpath", "expression" }`;
    3. `dom-checks`: assertions `hasClass`, `lacksClass`, `computedStyleEquals`, `attributeEquals` and `attributeAbsent`, and `remember` from an attribute;
    4. `page-script`: steps `evaluate` and `expectScript` that run a script the project declares by name;
    5. `inline-page-script`: `evaluate` and `expectScript` with the script's text in the plan. It needs `page-script` too;
    6. `database-command`: steps `database` and `expectDatabase` that run a command the project declares by name. They may also stand in `cleanup`.
  - **One parser.** `planParser(project)` reads the project's enabled set. A disabled feature is refused with the new plan error `unsafe_feature_disabled`, at the path where it appears, such as `$.steps[3].locator.by`. Every use is reported, not only the first, and no value is echoed. There is no second parser, flag or mode.
  - **CSS and XPath locators.** Wherever a plan takes a locator, it may take one of these, with SPEC-30's `position` and two more fields:
    - `hasText`: literal text or a value reference. It keeps elements whose normalised text content contains it, like Playwright's `filter({ hasText })`;
    - `inside`: any locator, up to depth 3. The selector is evaluated inside the one element it resolves to.
    - The selector or expression is literal plan text, 1 to 512 characters, single-line and printable, and holds no `{`, `}`, `;` or `@`. It never takes a value reference, so what a locator can match is fixed when the plan is approved.
    - An XPath expression must select elements.
    - A selector the browser rejects fails the step with `selector-invalid` at run time.
  - **DOM checks.**
    - Class names are single tokens.
    - A style property is a lowercase CSS property name. Its expected value is compared with the string `getComputedStyle` returns, such as `rgb(220, 38, 38)`.
    - An attribute name is lowercase letters, digits and hyphens. Attribute values compared or remembered follow SPEC-30's rules: compared, never recorded, and redacted where kept.
  - **Page scripts.**
    - **Declaration.** A named script is declared in `project.json` under `unsafeFeatures.pageScripts.scripts`. Its source is a file under `plans/scripts/`, which is already a trusted path (SPEC-02). It declares typed parameters (SPEC-32's `ParameterType`, without `secret`), `effect` (`read` or `write`), result `fields` as JSON pointers, a timeout, `maximumResultBytes` and `allowInProposals`.
    - **Running.** The script runs as one function in the page's main world of the current frame, after the determinism kit, with its arguments passed as JSON values and never spliced into the source. Its return value is decoded as JSON under size and depth limits. Only the declared fields are read, to compare or to remember. The raw value is never recorded; the evidence keeps its sha256.
    - **Inline scripts.** An inline script has the same shape, with its text in the plan (at most 4,000 characters). It needs `allowInline: true`.
    - **Checks.** `expectScript` takes SPEC-32's `BackendAssertion` on a `read` script. It repeats until it passes or `scriptCheckTimeoutMilliseconds` runs out.
  - **Database commands.**
    - **Declaration.** Each is declared in `project.json` under `unsafeFeatures.databaseCommands.commands`, with:
      - a declared service, which must be `private` and gains a `port` (SPEC-32 `services`);
      - a workload image by digest, and an argument vector of literals and whole-argument parameters;
      - environment literals and secrets (secrets only in the environment, never in arguments);
      - `effect`, `successExitCodes`, output `none` or `json` with `fields`, a timeout, `maximumOutputBytes` and `allowInProposals`.
    - **Running.** The command runs in a workload container (SPEC-35's `WorkloadRunner`), without a shell. Its network reaches only the declared service's address and port; nothing else.
    - **Checks.** `expectDatabase` checks a field of a `read` command's output and repeats like `expectBackend`.
    - **Option injection.** A text argument may not start with `-` unless the declaration places its parameter after a literal `--`; otherwise it fails with `parameter-invalid`.
  - **Policy gate additions (SPEC-03):**
    - a proposal (an unapproved plan) may not run an inline script (`inline-script-in-proposal`);
    - a proposal may not run a `write` script or `write` command whose declaration does not set `allowInProposals` (`side-effect-in-proposal`);
    - a command whose service is on a production origin is denied (`production-origin`);
    - commands and scripts count toward `maximumCalls`;
    - the runtime guard runs on every element a CSS or XPath locator resolves, as on any other. `unnamed-control` applies to them unless the selector or expression is listed exactly in `unsafeFeatures.unnamedControlsAllowed`.
  - **Labels and records.**
    - The parser returns the sorted list of unsafe features a plan uses. The plan hash covers them, because they are plan content.
    - The result and the manifest record the list beside the plan hash. The manifest also records the sha256 of each named script's source and of each command declaration used.
    - The run's `GuaranteeStatement` (SPEC-35) has level `host`, with each lost guarantee and the feature that lost it (table below). Every output carries it: result JSON, JUnit, SARIF, job summary, report banner, PR comment verdict line and manifest. Each says "unsafe" and names the features.
  - **Never counted as verified evidence.** Runs using an unsafe feature are excluded from `verifiedWithoutReviewShare`, `tracedCriteriaShare` and every ladder level (SPEC-21), and are counted beside them. They may still pass or fail a CI job.
  - **Replay.** Database commands are never repeated in replay; their recorded outputs are fed to the engine, as SPEC-32 does for calls, and `nonHermeticInputs` lists `database-commands`. Page scripts run again in replay, inside the determinism kit.
  - **Coverage study.** `assessCoverage` reports a second share, "1.3 with unsafe features", beside the closed-language share. The language-fit kill criterion stays computed on the closed share.
- **Non-goals:**
  - unsafe features in plans below 1.3, or enabled anywhere but the trusted project file;
  - value references inside a selector or expression, or a script source built from plan values;
  - secrets passed to page scripts, or as command arguments;
  - direct database connections, with SQL sent over a declared connection. They need a database driver dependency and its review (`docs/decisions/`), and wait for demand. A declared command such as `psql` or a seed script covers the need meanwhile;
  - branching, loops, regular expressions or string operations, still out (SPEC-30);
  - readable text forms for these features. SPEC-28 owns the readable form, and until it adds them they are written in JSON;
  - `revisum draft` emitting unsafe features. Drafts stay in the closed language.

**Which guarantees no longer hold.** Each feature loses the guarantees marked, and only those. Egress control (SPEC-07), no ambient credentials, secret redaction and the leak scan (SPEC-04), the parser as the only path to a `Plan`, and person approval of every declaration (SPEC-02) hold for all six. PII masking of captures (SPEC-09) holds for all but page scripts.

| Feature | Guarantee lost (`GuaranteeId`) | What that means |
|---|---|---|
| `css-locator`, `xpath-locator` | `semantic-locators` | Elements are found by page structure, not by role or name. A pass doesn't show that a person or assistive technology can find the control, and markup changes break the test. The static gate can't read an accessible name from a selector, so `irreversible-action` is judged only by the runtime guard, on the resolved element |
| `dom-checks` | `observable-checks` | The check reads implementation details (classes, computed values, attributes), not what a user perceives or assistive technology exposes |
| `page-script`, `inline-page-script` | `plan-closed`, `actions-guarded`, `observable-checks`, `pii-masked` | The script runs arbitrary code in the page. It can click, type, submit, navigate and call `fetch` on allowed origins with synthetic events the runtime guard never sees, so it can press "Delete account". It can read whatever the page holds, including non-HttpOnly cookies, storage and app state, and it can change the page the masker reads before a capture. Egress and redaction still apply, and the return value is reduced to declared fields |
| `database-command` | `plan-closed`, `actions-guarded`, `replay-identical` | The command is the team's program, with whatever authority its database credential grants. The policy gate judges only its declaration, effect and service, never what it does. Revisum guarantees argument boundaries and network reach, not what the program does with an argument, so SQL injection inside the team's script is the team's to prevent. Replay reuses recorded outputs and can't show the database was in the same state |

## Interfaces and types

```ts
// contracts. Plan 1.3 additions; shapes not shown are as in plan 1.2 (SPEC-30 to SPEC-34).
export const PLAN_VERSION = { major: 1, minor: 3 } as const;       // "1.2" and "1.1" plans parse unchanged

export const UNSAFE_FEATURES = ['css-locator', 'xpath-locator', 'dom-checks', 'page-script',
  'inline-page-script', 'database-command'] as const;
export type UnsafeFeature = (typeof UNSAFE_FEATURES)[number];

// Locator gains two kinds. Selector text is literal; only hasText may hold a value reference.
//  | { by: 'css'; selector: SafeText; hasText?: Text; inside?: LocatorWith<Text>; position?: Position }
//  | { by: 'xpath'; expression: SafeText; hasText?: Text; inside?: LocatorWith<Text>; position?: Position }

// ElementAssertion gains (feature dom-checks):
//  | { kind: 'hasClass' | 'lacksClass'; value: SafeText }                      // one class token
//  | { kind: 'computedStyleEquals'; property: SafeText; value: SafeText }      // lowercase property name
//  | { kind: 'attributeEquals'; name: SafeText; value: Text }
//  | { kind: 'attributeAbsent'; name: SafeText }
// RememberSource gains: { element: Locator; read: 'attribute'; attribute: SafeText }

export type ScriptName = Brand<string, 'ScriptName'>;               // ^[a-z][A-Za-z0-9]{0,63}$
export type CommandName = Brand<string, 'CommandName'>;             // same pattern
export type ScriptParameterType = Exclude<ParameterType, { kind: 'secret' }>;
export type PageScriptDeclaration = {
  readonly file: string;                                            // under plans/scripts/, ".js"; trusted (SPEC-02)
  readonly parameters: Readonly<Record<ParameterName, ScriptParameterType>>;
  readonly effect: 'read' | 'write';
  readonly fields?: Readonly<Record<FieldName, JsonPointer>>;
  readonly allowInProposals: boolean;                               // default false
  readonly timeoutMilliseconds?: number; readonly maximumResultBytes?: number;   // defaults 5 s and 256 KiB
};
export type InlineScript = { readonly source: string; readonly effect: 'read' | 'write';    // 1 to 4,000 characters;
  readonly fields?: Readonly<Record<FieldName, JsonPointer>> };     // line breaks allowed, no control characters
export type CommandArgument = { readonly literal: string } | { readonly $parameter: ParameterName };
export type DatabaseCommandDeclaration = {
  readonly service: ServiceName;                                    // declared private, with a port
  readonly image: ImageDigest;                                      // workload image (SPEC-35)
  readonly argv: readonly CommandArgument[];                        // whole arguments; no shell
  readonly parameters: Readonly<Record<ParameterName, ScriptParameterType>>;
  readonly environment?: Readonly<Record<string, EnvironmentValue>>;   // SPEC-35; reserved names refused
  readonly effect: 'read' | 'write';
  readonly successExitCodes: readonly number[];                     // default [0]
  readonly output: 'none' | 'json';
  readonly fields?: Readonly<Record<FieldName, JsonPointer>>;       // output 'json' only
  readonly allowInProposals: boolean;                               // default false
  readonly timeoutMilliseconds?: number; readonly maximumOutputBytes?: number;   // defaults 60 s and 1 MiB
};
// ProjectData gains (absent: every feature off):
export type UnsafeFeaturesDeclaration = {
  readonly cssLocators?: true; readonly xpathLocators?: true; readonly domChecks?: true;
  readonly pageScripts?: { readonly scripts: Readonly<Record<ScriptName, PageScriptDeclaration>>; readonly allowInline: boolean };
  readonly databaseCommands?: { readonly commands: Readonly<Record<CommandName, DatabaseCommandDeclaration>> };
  readonly unnamedControlsAllowed?: readonly SafeText[];            // exact selectors or expressions
};
// limits gain: scriptCheckTimeoutMilliseconds (default 10000, at most 120000).
// services gain: port?: number (required for a database command's service).

// Plan 1.3 steps:
//  | { type: 'evaluate'; script: ScriptName | { inline: InlineScript }; arguments: ScriptArguments;
//      remember?: Readonly<Record<ValueName, FieldName>> }
//  | { type: 'expectScript'; script: ScriptName | { inline: InlineScript }; arguments: ScriptArguments; field: FieldName;
//      assert: BackendAssertion; criterionId: CriterionId }        // effect must be 'read'
//  | { type: 'database'; command: CommandName; arguments: ScriptArguments; remember?: Readonly<Record<ValueName, FieldName>> }
//  | { type: 'expectDatabase'; command: CommandName; arguments: ScriptArguments; field: FieldName;
//      assert: BackendAssertion; criterionId: CriterionId }        // effect must be 'read'
// cleanup may hold 'database' steps. evaluate and expectScript may stand in frame and newTab; database steps may not.
export type ScriptArguments = Readonly<Record<ParameterName, TextOrValue | number | boolean>>;

// engine
export function unsafeFeaturesOf(plan: Plan): readonly UnsafeFeature[];   // sorted; empty for a closed plan
// PlanErrorCode additions: 'unsafe_feature_disabled'
// PolicyRuleId additions (SPEC-03): 'inline-script-in-proposal'
// StepErrorCode and driver additions: 'selector-invalid', 'script-failed', 'script-timeout', 'script-result-invalid',
//   'script-result-too-large', 'command-failed', 'command-timeout', 'command-output-invalid'; commands reuse
//   'parameter-invalid', 'egress-blocked', 'field-missing' and 'cleanup-failed' (SPEC-32)
// RunManifest (SPEC-08) gains: unsafeFeatures: readonly UnsafeFeature[];
//   unsafeDeclarations: readonly { kind: 'script' | 'command'; name: string; sha256: string }[]
// RunResult (SPEC-11) gains: unsafeFeatures: readonly UnsafeFeature[]; a non-empty list is the 'unsafe' label
// EgressPolicy (SPEC-07) gains: allowTcpServices: readonly ServiceName[]   (database commands only)
```

**Rules the criteria rely on.**

- Undeclared script, command or field names, wrong arguments, and a `write` script or command in a check reuse SPEC-32's codes (`unknown_value`, `missing_field`, `unknown_field`, `wrong_type`, `too_long`). A secret reference as a script or command argument is `wrong_type`.
- A selector or expression that is too long is `too_long`. One holding a line break, `{`, `}`, `;` or `@` is `unsafe_text`. A value reference there is `wrong_type`.
- An inline script needs both `page-script` and `inline-page-script`. If either is off, the error is `unsafe_feature_disabled` at `.script.inline`.
- A failed `evaluate` or `database` step ends the run `Errored`, and cleanup still runs. A failed check ends it `Failed`. `write` steps are never repeated.
- The guarantee statement is computed from `unsafeFeaturesOf(plan)` and the run's isolation alone, never from what a run happened to do, so two runs of one plan carry the same label.

**Build notes.** Points the criteria leave open, settled while building (2026-10-29; `docs/decisions/answers.md`):

- **Version tests.** Tests that pinned "1.2 is the newest version" now look up their own version's changelog entry. A "future version" example is computed as one past the newest. A later bump needs no test edits (founder, 2026-10-29).
- **Closed runs unchanged.** `unsafeFeatures` on `RunResult` and `RunManifest` is present only when a plan uses one, as `secrets` is. Closed runs keep today's hashes exactly (AC-SPEC-36-03).
- **Error paths for a disabled feature.**
  - Locators: `.locator.by`.
  - Inline scripts: `.script.inline`.
  - Assertions: `.assert.kind`.
  - Remember sources: `.from.read`.
  - Steps: `.type`.
  - A too-deep `inside` chain is refused at the fourth `inside`.
- **Surfaces.**
  - `GuaranteeConditions` gains `unsafeFeatures`; each lost guarantee's reason names the feature.
  - `RunInputs` gains `scriptSources`, keyed by declared file path.
  - In M1 a page-script or database plan still builds its manifest; those steps report `unsupported-step`.
- **Feature names.** `unsafeFeaturesOf` names each feature once, by what the plan uses. A plan whose only script is inline lists `inline-page-script`, not `page-script`.
- **Script files.** Declared script files are trusted files; changing one raises `changed-with-code` now. Reading their protected-branch versions comes with M2, when scripts run.
- **Coverage.** The tool reports `shareWithUnsafeFeatures` and `shareWithUnsafeFeaturesBySample` beside the closed shares. The closed share counts no plan that uses an unsafe feature.
- **Metrics and levels (AC-SPEC-36-18)** are built and tested with SPEC-15 and SPEC-21, as SPEC-35's AC-17 is.
- **Golden plans.** 1.3 golden plans live in `golden/unsafe-plans/` and parse against an unsafe-enabled project. `golden/plans/` stays 1.1 and 1.2.
- **Readable text.** Unsafe constructs have readable forms, each line marked `Unsafe:` (SPEC-28, "Readable syntax for plan 1.3"). Until that code lands, `readablePlanText` refuses them with `no-readable-form`.
- **Safety rules the code adds.**
  - A database command's first argument is always literal, so a plan never chooses the program.
  - A production database command is denied even in an approved plan, whatever the policy says.
  - Inline script source has its own brand, `ScriptSource`. Credential-shaped text in it is `literal_secret`.
  - A plan naming a script whose source the run wasn't given is refused with `script-source-missing`, so the manifest never lacks a script's hash.
- **Changelog.** This spec's first code commit dates the 1.2 entry and opens "1.3 (unreleased)", naming the new constructs, codes and schema hash.

## Acceptance criteria

- AC-SPEC-36-01: When a plan declaring `"1.3"` uses a feature its project does not enable, the parser shall refuse it with `unsafe_feature_disabled` at every path where a disabled feature appears, echo no value and make zero driver, script or command calls (oracle: specified; one hostile plan per feature, and one using all six).
- AC-SPEC-36-02: When a plan declaring `"1.2"` or `"1.1"` uses any 1.3 feature, it shall be refused with the code and path that version's parser gives, even when the project enables the feature (oracle: regression; extends AC-SPEC-30-01).
- AC-SPEC-36-03: When a project enables no unsafe feature, every 1.1 and 1.2 golden plan shall parse to the same `Plan`, and every golden run, report and replay hash shall be byte-identical to before this spec (oracle: regression).
- AC-SPEC-36-04: When the change under test adds or widens `unsafeFeatures`, or edits a script under `plans/scripts/`, the run shall use the protected-branch versions and raise `changed-with-code` naming each file. A plan in that change using the new feature shall be refused with `unsafe_feature_disabled` (oracle: specified; hostile fixture repository; extends AC-SPEC-02-02).
- AC-SPEC-36-05: When a CSS or XPath locator holds a value reference, a line break, `{`, `}`, `;` or `@`, more than 512 characters, or an `inside` chain deeper than 3, the parser shall refuse it with `wrong_type`, `unsafe_text`, `too_long` or `too_large` and its path (oracle: specified).
- AC-SPEC-36-06: When a CSS or XPath locator resolves an element for an action, the runtime guard shall judge it as any other (oracle: specified; extends AC-SPEC-03-01 and AC-SPEC-03-10):
  - a button named "Delete account" found by `button.danger` shall be denied `irreversible-action` with zero input events;
  - an unnamed control shall be denied `unnamed-control` unless its exact selector is in `unnamedControlsAllowed`.
- AC-SPEC-36-07: When fixture pages are checked with `hasClass`, `lacksClass`, `computedStyleEquals` and `attributeEquals`, each check shall pass on its matching twin and fail on its mismatched twin. A remembered attribute value shall appear in no artefact, except redacted where text is kept (oracle: specified; leak scan with planted values).
- AC-SPEC-36-08: When a proposal holds an inline script, the gate shall deny it with `inline-script-in-proposal`. A proposal with a `write` script or `write` command whose declaration lacks `allowInProposals` shall be denied with `side-effect-in-proposal`. In each case zero scripts and commands shall run (oracle: specified; extends AC-SPEC-32-06).
- AC-SPEC-36-09: When a page script's arguments hold quotes, `"); fetch(`, template-literal text and non-Latin text, the script shall receive each as one JSON value, and its source text shall be byte-identical to the declared file's (oracle: metamorphic; 1,000 generated argument sets).
- AC-SPEC-36-10: When a hostile page script tries to fetch an undeclared origin, open a WebSocket or send a beacon, each shall be blocked by the proxy and recorded (oracle: specified; extends AC-SPEC-07-01). When it returns a result over `maximumResultBytes`, nested past the depth limit, cyclic or not JSON, the step shall fail with `script-result-too-large` or `script-result-invalid`. When it throws or never settles, the step shall fail with `script-failed` or `script-timeout`, and the run shall end `Errored`.
- AC-SPEC-36-11: When a page script returns a value holding a planted secret and a planted session cookie, only the declared fields shall be read, and the leak scan shall find neither value in any output (oracle: specified; extends AC-SPEC-04-04).
- AC-SPEC-36-12: When a database command's arguments hold `; rm -rf /`, `$(id)`, a line break or a leading `-`, the first three shall reach the program as literal single arguments (oracle: specified; fixture command echoes its argument vector). The leading `-` shall fail with `parameter-invalid` unless the parameter follows a literal `--`.
- AC-SPEC-36-13: When a database command tries to reach any address other than its service's address and port, the attempt shall be blocked and recorded (oracle: specified). That covers the internet, another declared service, the metadata address and the CI host. Its environment shall hold only the declared variables. A command whose service is on a production origin shall be denied `production-origin` before it starts.
- AC-SPEC-36-14: When a database command exits outside `successExitCodes`, times out, or prints output over `maximumOutputBytes` or not JSON, the step shall fail with `command-failed`, `command-timeout` or `command-output-invalid`. Later steps shall be skipped and cleanup shall still run. A `write` command that times out shall have run exactly once (oracle: specified).
- AC-SPEC-36-15: When a run with database commands is replayed 20 times, no command shall run, the recorded outputs shall be fed to the engine, the result hashes shall be identical, and `nonHermeticInputs` shall list `database-commands` (oracle: regression; extends AC-SPEC-32-13).
- AC-SPEC-36-16: When a run uses any unsafe feature, it shall carry the `unsafe` label and the features it used on every output (oracle: specified). The outputs are result JSON, JUnit, SARIF, job summary, report banner, PR comment verdict line and manifest. Its guarantee statement shall have level `host` and list exactly the lost guarantees in this spec's table. The claim lint shall fail a template that applies "verified" or "closed language" to such a run.
- AC-SPEC-36-17: When a plan's unsafe features or a declaration it uses change, the manifest hash shall change. That covers adding a feature, one byte of a named script's source, or a command's argument vector. Two runs of one plan shall carry the same features and guarantee statement (oracle: metamorphic; extends AC-SPEC-08-02).
- AC-SPEC-36-18: When a fixture history mixes closed and unsafe runs, `verifiedWithoutReviewShare`, `tracedCriteriaShare` and `levelAt` shall be computed over the closed runs only, and the unsafe runs' counts shall be reported beside them (oracle: specified).
- AC-SPEC-36-19: When the coverage study runs, it shall report the closed-language share and the "1.3 with unsafe features" share side by side, overall and per sample (oracle: specified; extends AC-SPEC-01-01). Every intent counted by the second share shall have a 1.3 plan that parses under its suite's project. The kill-criterion line shall use the closed share.
- AC-SPEC-36-20: When `contracts`, `engine`, `runner` and the drivers are built, none shall gain a runtime dependency (oracle: specified). `reveal`'s allow-list shall gain only runner's workload-environment module, and no driver module shall pass a `Secret` to a page script.

## Dependencies

- SPEC-01, SPEC-30 to SPEC-34 (plan 1.2, values, `remember`, positions, `BackendAssertion`, `ParameterType`, cleanup, `misplaced_step`), SPEC-02 (trusted files, approval), SPEC-03 (gate, guard), SPEC-04 (secrets, leak scan), SPEC-27 (unions).
- SPEC-06 (driver: CSS and XPath resolution, DOM reads, script execution), SPEC-07 (egress, TCP allowance), SPEC-08 (manifest, replay of recorded outputs), SPEC-11 and SPEC-12 (labels), SPEC-35 (`WorkloadRunner`, `EnvironmentValue`, `GuaranteeStatement`).
- **Database commands run nothing before SPEC-07's criteria and SPEC-35's workload runner pass.**
- Research background: the guarantee table (`04` Finding 1), whose "plan uses only known actions" row these features weaken, and the language-fit criterion (`09` §6).

## Milestone

- **M1, after SPEC-35's M1 parts:** dating the 1.2 entry, plan 1.3, the project declarations and their parser rules, `unsafe_feature_disabled`, the policy additions, `unsafeFeaturesOf`, the guarantee statement and labels in the result, and the coverage study's second share. Plans are checked by the parser, so the projected share becomes a measured one (criteria 01 to 05, 08, 16 for the result, 17 to 19).
- **M2, with SPEC-06, SPEC-07 and SPEC-08:** CSS and XPath resolution, DOM checks and page scripts in `driver-cdp` and `driver-playwright`. Then, after SPEC-35's workload runner, database commands and their replay (criteria 06, 07, 09 to 15, 20).
  - **Page parts** (alignment, 2026-10-31): criteria 06, 07, 09, 10, 11 and the driver half of 20. Database commands (12 to 15, and runner's half of 20) are a later step.
    - **Capability model.** As SPEC-30 to SPEC-34: the engine refuses a step with `unsupported-step`, dispatching nothing, unless the driver declares the feature in `AdapterInfo.performs`. The new features are `structuralLocators` (CSS and XPath, with `hasText` and `inside`), `domChecks` (the five assertions and `remember` from an attribute, which also needs `rememberedValues`) and `pageScripts` (named and inline). This spec names both drivers, so the CDP driver and the Playwright fallback declare all three. Browser tests run on `cdp-chromium` and `playwright-chromium`.
    - **Script shape.** A script's source, from its file or inline, is one function expression, such as `(args) => ({ count: args.limit })`. The driver calls it once with a single argument: an object holding the named arguments as JSON values. The source is passed unchanged; arguments are never spliced into it. It runs in the main world of the current frame, may return a promise, and is awaited.
    - **Who checks what.** The driver serialises the returned value to JSON text in the page and enforces the script's timeout in real time (`script-timeout`). A throw or rejection is `script-failed`; a cyclic value, or one JSON can't represent (`undefined`, a function), is `script-result-invalid`. The text is outside data, so the engine decodes it with a hand-written decoder: over `maximumResultBytes` is `script-result-too-large`, nested deeper than 64 is `script-result-invalid`. The engine then reads only the declared fields by JSON pointer. The raw text is never recorded; the evidence keeps its sha256.
    - **Run outcome.** A failed `evaluate` ends the run `Errored` and cleanup still runs. `expectScript` reruns its `read` script until the assertion passes or `scriptCheckTimeoutMilliseconds` runs out, then ends the run `Failed`. A `write` script never reruns.
    - **Egress (AC-10)** runs with SPEC-07's in-process proxy and a real Chromium in `npm run check`, as SPEC-33's did.
    - **Error codes.** `selector-invalid` and the four `script-*` codes join the pinned lists under the standing exception.
  - **Database commands** (alignment, 2026-10-31): criteria 12, 13, 14 and runner's half of 20. Replay (15) comes with SPEC-08, as SPEC-32's call replay does.
    - **Port.** `contracts` gains a `DatabaseCommandRunner` port that `RunInputs` may carry. The engine builds each request (image, whole-argument vector, environment, egress policy, timeout, output limit), and `cli` wires the port to runner's `WorkloadRunner`, so engine never imports runner. A run without the port reports `database` and `expectDatabase` as `unsupported-step`. Engine criteria (12's argument checks, 14) are tested with a fake port that echoes its argument vector; the real container path is tested in `test/containers/` (`npm run check:containers`, CI's container step).
    - **Arguments.** Each parameter fills exactly one argument; nothing is split or joined, and no shell runs. A text argument starting with `-` fails with `parameter-invalid`, unless a literal `--` comes before it in the declared vector. The first argument is always literal (M1 rule).
    - **Network reach.** The workload container stays on the run's network with no route out (`--internal`). For each service in `EgressPolicy.allowTcpServices`, the proxy container relays one TCP port to that service's resolved address and port, refusing metadata addresses as today. The workload container maps the service's host name to the proxy (`--add-host`), so the command connects by the declared name. Every other address has no route; connection attempts the proxy sees are recorded as egress events on the `process` channel. The environment holds only the declared variables, with no proxy variables, since the command speaks TCP, not HTTP.
    - **Outcomes.** The engine decodes the output itself: an exit code outside `successExitCodes` is `command-failed`, a timeout `command-timeout`, output over `maximumOutputBytes` or not JSON (when `output` is `json`) `command-output-invalid`. Any of them ends the run `Errored`, skips later steps and still runs cleanup. The engine never retries a `write` command; `expectDatabase` reruns its `read` command until it passes or `backendCheckTimeoutMilliseconds` runs out, then ends the run `Failed`.
    - **Records.** As SPEC-32's calls: each command's record holds its name, service, exit code, timing and output sha256, never raw output or environment values. `nonHermeticInputs` lists `database-commands` from this step; replaying recorded outputs without starting a container comes with SPEC-08.
    - **Error codes.** `command-failed`, `command-timeout` and `command-output-invalid` join the pinned lists under the standing exception.
- **M3, with SPEC-11 and SPEC-12:** labels in every exporter, the report and the PR comment (criterion 16 in full).
- **M4, with SPEC-16 and SPEC-17:** `doctor` checks for unsafe declarations and the claim lint wording.

## Satisfies

Founder decision 2026-10-28 (`docs/decisions/language-fit-pivot.md`); it extends FR-01, FR-05, NFR-03 and NFR-04.
