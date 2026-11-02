# SPEC-01: Plan language and parser

## Purpose

Make AI output reach execution only as a validated, typed, closed plan (AI contained, R4). It serves two problems: "AI writes features faster than we can check them" (UP-01) and "letting AI agents into our pipeline feels like handing over the keys" (UP-09). An agent can draft tests fast, and nothing it writes runs unparsed. Outcome: plan language v1.1 with a published JSON Schema, a parser that brands plans, and a run-time brand check.

Changed by the founder, 2026-11-02: the plan language has one version, `"1.3"`, the only value a plan may declare. Any other is refused with `version_unsupported`, so no plan partly runs. `migratePlan`, `CriterionMapping`, `no_criterion_id` and the version 1 fixtures are removed, and AC-SPEC-01-08 is withdrawn. The coverage study's tool is removed too; its findings stay in `docs/coverage-study/`. Version numbers below are the history of how the language grew.

## Scope and non-goals

- **In:**
  - a coverage study on about 10 public suites;
  - plan v1.1, which adds `select`, `hover`, `upload`, `frame`, `dialog`, `absent` (distinct from `hidden`) and secret references by `secretName`;
  - vacuity rules, and an acceptance-criterion id (`criterionId`) on every assertion;
  - a per-project parser, a run-time brand check in `run()` and a lint banning casts to `Plan`;
  - JSON Schema, TypeScript types, golden examples and a changelog;
  - golden examples at the one version, with criterion ids;
  - every AI text output typed `unknown` until parsed;
  - this parser as the only path to a `Plan` for every authoring route: hand-written JSON or readable text, the customer's own LLM, `core draft`, tickets, the builder, the recorder and the chatbot (SPEC-28). Readable text is first read into plain JSON, then parsed here.
- **Non-goals:** CSS, XPath, script or sleep steps; popups, downloads and multi-page steps (they return `unsupported-step` until phase 2); protocol-pack steps (SPEC-23); the readable text form and the drafting routes (SPEC-28), which add no second parser.

## Interfaces and types

```ts
// Brand, Result, Role, AllowedUrl, ElementAssertion, PageAssertion and PlanErrorCode are shared core types; see SPEC-27.
export const PLAN_VERSION = { major: 1, minor: 1 } as const;
export type Locator =
  | { by: 'role'; role: Role; name?: string }
  | { by: 'label'; label: string }
  | { by: 'text'; text: string }
  | { by: 'testId'; testId: string };
export type CriterionId = Brand<string, 'CriterionId'>;   // acceptance-criterion id from the user's spec, e.g. "AC-3"
export type FixtureName = Brand<string, 'FixtureName'>;   // a file declared in the trusted project's fixtures
export type CaptureName = Brand<string, 'CaptureName'>;   // names a screenshot in the evidence
export type Key = 'Enter' | 'Space' | 'Tab' | 'Escape' | 'Backspace' | 'Delete' | 'Home' | 'End'
  | 'PageUp' | 'PageDown' | 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';
export type Step =
  | { type: 'navigate'; url: AllowedUrl }
  | { type: 'click' | 'hover'; locator: Locator }
  | { type: 'fill'; locator: Locator; value: string | { secretName: SecretName } }
  | { type: 'select'; locator: Locator; option: string }
  | { type: 'upload'; locator: Locator; fixture: FixtureName }
  | { type: 'press'; locator: Locator; key: Key }
  | { type: 'frame'; locator: Locator; steps: readonly Step[] }
  | { type: 'dialog'; action: 'accept' | 'dismiss'; expectText?: string }
  | { type: 'expect'; locator: Locator; assert: ElementAssertion; criterionId: CriterionId }
  | { type: 'expectPage'; assert: PageAssertion; criterionId: CriterionId }
  | { type: 'a11yAudit'; mode: 'gate' | 'report' }
  | { type: 'capture'; name: CaptureName };
// Steps that act on an element; the driver's ActionRunner port performs them.
export type ActionStep = Extract<Step, { type: 'click' | 'hover' | 'fill' | 'select' | 'upload' | 'press' }>;
export type PlanData = {
  readonly version: `${number}.${number}`; readonly name: string;
  readonly targets: readonly TargetId[]; readonly steps: readonly Step[];
};
export type Plan = Brand<PlanData, 'Plan'>;
export type PlanLimits = { readonly maximumPlanBytes: number; readonly maximumSteps: number; readonly maximumFrameDepth: number };
// The parts of the trusted project the parser reads (ProjectData: SPEC-02).
export type Project = Pick<ProjectData, 'origins' | 'secretNames' | 'fixtures' | 'packs' | 'limits'>;
export type PlanError = { readonly code: PlanErrorCode; readonly path: string }; // never echoes a value
export function planParser(project: Project): (input: unknown) => Result<Plan, readonly PlanError[]>;
export function assertBranded(plan: unknown): asserts plan is Plan;            // called first in run()
export type AiText = Brand<string, 'AiText'>;                                     // stored as a suggestion only
export function parseAiText(input: unknown, maximumCharacters: number): Result<AiText, PlanError>;
```

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; the first is the founder's decision, the rest are recorded in `docs/decisions/answers.md`):

- **Envelope.** The plan keeps the seeded `meta` header (`featureId`, `specReference`, `title`) instead of `name`. The shared test plans (`signupPlan`, the hostile-plan base) move to v1.1, with a `criterionId` on each assertion, in a tests commit of their own (founder, 2026-10-28).
- **Vacuity.** No assertion, an empty assertion (`assert: {}`) or a missing `criterionId` is rejected as `vacuous`.
- **API-step hostile plans.** Their steps belong to protocol packs (SPEC-23), so the test asserts rejection with zero calls, not a specific code. A protocol-relative URL keeps the seeded code `origin_not_allowed`.
- **Limits and references.** `maximumFrameDepth` joins the project's `limits`; a frame inside a frame has depth 2. The project file gains `secretNames` and `fixtures` lists (empty by default) so the parser can check `secretName` and `upload` references; SPEC-02 builds on them.
- **AI text.** `parseAiText` uses the same codes as the parser's text rules and accepts line breaks.
- **Coverage study (AC-SPEC-01-01).** Changed by the founder, 2026-11-02: `assessCoverage` and `tools/coverage-study.ts` are removed, and the data and reports stay in `docs/coverage-study/`. The study is a data file, `docs/coverage-study/intents.json`: one entry per sampled test intent, with its suite, source URL, test name, verdict and reason, and for an expressible intent a v1.1 plan that must parse. Engine's `assessCoverage(input: unknown, parse)` decodes it and returns each intent's verdict and reason and the expressible share. An intent marked expressible whose plan does not parse counts as not expressible. `tools/coverage-study.ts` runs it and writes `docs/coverage-study/report.md`.
- **Schema and changelog (AC-SPEC-01-10).** No release build exists before SPEC-17, so the check runs in `npm run lint`. Engine's `planJsonSchema()` builds the schema from the same tables the decoders use, with no new dependency. The check fails when `docs/plan-language/plan.schema.json` differs from it, when a golden plan in `golden/plans/` doesn't validate against it, or when its sha256 is missing from the newest entry in `docs/plan-language/CHANGELOG.md`.

## Acceptance criteria

- AC-SPEC-01-01: When the coverage study runs over the sampled suites, core shall record each test intent as expressible or not, with the reason, and report the expressible share (oracle: specified; the MVP plan's kill criterion is 70%, research `09`). Changed by the founder, 2026-11-02: met and recorded in `docs/coverage-study/`; the tool is removed.
- AC-SPEC-01-02: When any hostile plan from the core skeleton's and API-step suites (spikes P3 and P7) is parsed, core shall reject it with its expected code and make zero driver or network calls (oracle: specified; reuses the core skeleton's hostile proofs and AC-p7-04).
- AC-SPEC-01-03: When a plan has an unknown key, step or value at any depth, core shall reject it with the code and JSON path, and the error shall contain no input value (oracle: specified; reuses AC-p7-02).
- AC-SPEC-01-04: When a plan has no assertion, an empty assertion, or an assertion without a `criterionId`, core shall reject it as vacuous (oracle: specified).
- AC-SPEC-01-05: When `run()` receives an object built by a cast rather than by the parser, core shall refuse it before any side effect (oracle: specified).
- AC-SPEC-01-06: When the source contains a cast to `Plan` outside the parser, lint shall fail (oracle: specified).
- AC-SPEC-01-07: When a plan uses a step newer than the running core's version, core shall reject it rather than skip it (oracle: specified). Changed by the founder, 2026-11-02: a plan declaring any version but `"1.3"` is rejected with `version_unsupported`.
- AC-SPEC-01-08: Withdrawn. Changed by the founder, 2026-11-02: the language has one version, and nothing migrates a plan to it.
- AC-SPEC-01-09: When an AI writer returns non-text, script-bearing or over-long output, `parseAiText` shall reject it and nothing shall be stored (oracle: specified; from the core skeleton's AI-text module).
- AC-SPEC-01-10: When a release is built, the JSON Schema, types, golden examples and changelog shall be regenerated, the schema shall validate every golden example, and a schema change with no changelog entry shall fail the build (oracle: specified).
- AC-SPEC-01-11: When a plan exceeds the size limit or nests frames beyond the depth limit, core shall reject it with `too_large` before walking it (oracle: specified).

## Dependencies

- SPEC-00, SPEC-27. SPEC-28 builds every authoring route on this parser.
- The core skeleton's plan, decoder, brand and AI-text modules (spike P3 `plan.ts`, `decode.ts`, `brand.ts` and `ai.ts`), copied with source hashes (AC-SPEC-00-11).
- Research background: architecture (`04` Findings 1 and 3); API and integration (`05` Finding 1). Schema adherence is not correctness [C-R13-045].

## Milestone

M1.

## Satisfies

FR-01, FR-02, FR-03, NFR-15
