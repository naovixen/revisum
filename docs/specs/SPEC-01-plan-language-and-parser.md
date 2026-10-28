# SPEC-01: Plan language and parser

## Purpose

Make AI output reach execution only as a validated, typed, closed plan (AI contained, R4). It serves two problems: "AI writes features faster than we can check them" (UP-01) and "letting AI agents into our pipeline feels like handing over the keys" (UP-09). An agent can draft tests fast, and nothing it writes runs unparsed. Outcome: plan language v1.1 with a published JSON Schema, a parser that brands plans, and a run-time brand check.

## Scope and non-goals

- **In:**
  - a coverage study on about 10 public suites;
  - plan v1.1, which adds `select`, `hover`, `upload`, `frame`, `dialog`, `absent` (distinct from `hidden`) and secret references by `secretName`;
  - vacuity rules, and an acceptance-criterion id (`criterionId`) on every assertion;
  - a per-project parser, a run-time brand check in `run()` and a lint banning casts to `Plan`;
  - JSON Schema, TypeScript types, golden examples and a changelog;
  - v1.1 parsed directly; v1.0 (N-1) accepted for 12 months only through `migratePlan`, a documented, pure migration that requires a `criterionId` for every assertion and fails with `no_criterion_id` otherwise;
  - golden examples kept at v1.1 with criterion ids, plus the v1.0 originals and their criterion mappings as migration fixtures;
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
// v1.0 assertions had no criterion id. The author supplies one per assertion, keyed by the assertion's JSON path;
// a missing entry fails with 'no_criterion_id', so nothing migrates silently.
export type CriterionMapping = Readonly<Record<string, CriterionId>>;
export function migratePlan(legacyPlan: unknown, mapping: CriterionMapping): Result<PlanData, readonly PlanError[]>; // pure
export type AiText = Brand<string, 'AiText'>;                                     // stored as a suggestion only
export function parseAiText(input: unknown, maximumCharacters: number): Result<AiText, PlanError>;
```

## Acceptance criteria

- AC-SPEC-01-01: When the coverage study runs over the sampled suites, core shall record each test intent as expressible or not, with the reason, and report the expressible share (oracle: specified; the MVP plan's kill criterion is 70%, research `09`).
- AC-SPEC-01-02: When any hostile plan from the core skeleton's and API-step suites (spikes P3 and P7) is parsed, core shall reject it with its expected code and make zero driver or network calls (oracle: specified; reuses the core skeleton's hostile proofs and AC-p7-04).
- AC-SPEC-01-03: When a plan has an unknown key, step or value at any depth, core shall reject it with the code and JSON path, and the error shall contain no input value (oracle: specified; reuses AC-p7-02).
- AC-SPEC-01-04: When a plan has no assertion, an empty assertion, or an assertion without a `criterionId`, core shall reject it as vacuous (oracle: specified).
- AC-SPEC-01-05: When `run()` receives an object built by a cast rather than by the parser, core shall refuse it before any side effect (oracle: specified).
- AC-SPEC-01-06: When the source contains a cast to `Plan` outside the parser, lint shall fail (oracle: specified).
- AC-SPEC-01-07: When a plan uses a step newer than the running core's version, core shall reject it rather than skip it (oracle: specified).
- AC-SPEC-01-08: When each v1.0 golden example is migrated with `migratePlan` and its criterion mapping, it shall migrate to v1.1 without loss (oracle: regression):
  - the output shall parse as v1.1 and equal the stored v1.1 golden example;
  - every step and assertion shall be unchanged apart from the added `criterionId`;
  - migrating twice shall give byte-identical output;
  - an assertion with no mapping entry shall fail with `no_criterion_id` and its JSON path.
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
