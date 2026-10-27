# SPEC-28: Plan authoring routes and the readable plan format

## Purpose

Let people and tools write plans in whatever way fits their workflow, while every route ends in the same typed plan. Hand-written JSON is unintuitive (founder, 2026-10-27), so core adds a readable text form and drafting routes. It serves "AI writes features faster than we can check them" (UP-01): checks are drafted as fast as features. It keeps "letting AI agents into our pipeline feels like handing over the keys" (UP-09) answered: every route yields a **draft**, which core's one plan parser (`parsePlan`, the function `planParser(project)` returns, SPEC-01) parses, the policy gate checks (SPEC-03) and a person approves (SPEC-02), verified or declared under the agent lock-down. No route's output, and no AI output, reaches execution unparsed.

## Scope and non-goals

- **In, phase 1:**
  - **Readable plan format (M1).** A plain-text `.plan` file with a small deterministic grammar (below): one statement per line, headers, indented frame blocks, and a `Criterion:` header that sets the criterion id for the `Expect` lines after it.
    - Errors give line and column and never echo a value.
    - Conversion with the JSON form is two-way and lossless for every `PlanData` field. JSON with its JSON Schema stays the wire format for agents.
    - Approval is keyed by the hash of the canonical JSON, so changing format or layout doesn't void an approval.
    - `core convert` writes either form from the other.
  - **One door for every route.** `admitDraft` reads the draft, calls `parsePlan` and records `plan.submitted` or `plan.rejected` with the draft's `PlanProvenance` in the audit log. The text reader only builds plain JSON; it never builds a `Plan`.
  - **Provenance.** Each draft carries a `PlanSource`:
    - `core-recorded` when core produced it (the `draft` command, ticket, builder, recorder, chat, an MCP session);
    - `declared` when an author names it for a file (`hand-written` by default, or `customer-llm`).
    - The source is recorded and shown, never trusted: it changes no gate, approval or metric.
  - **Route b, the customer's own LLM or agent:** it writes either form against the published JSON Schema and grammar reference. MCP (SPEC-18, phase 2a) accepts both forms.
  - **Route c, `core draft` (M4).** It turns the acceptance criteria of a spec, or of a ticket saved as Markdown, into a readable draft through the `AiPlanner` port, on the customer's own key or a local model.
    - The criteria are extracted deterministically from Markdown.
    - The planner sees only the criteria text, the grammar version, and the project's declared origins and targets. It never sees secrets, page content or artefacts. This egress is listed in the logging manifest (SPEC-09).
    - Model output is typed `unknown` and bounded by `parseAiText` (SPEC-01) before it becomes a draft.
    - The draft file is written with its errors placed by line, and is never approved by the command.
- **In, phase 2:**
  - **Route d, tickets (P2a, with SPEC-20).** Reads only a ticket's "Acceptance criteria" or "Testing considerations" section through the read-only tracker connector (GitHub Issues first), then drafts as route c. Ticket text is untrusted input.
  - **Route e, core's own interface (P2b).**
    - A local plan builder (a form plus a readable-text editor, validating live with the same reader and parser build), served on the loopback interface and opened from the report viewer. The report itself stays script-free (SPEC-12).
    - A plan recorder: a person drives a visible Chromium through the own CDP driver, and core writes a readable draft with role locators from the accessibility tree. Typed values in password fields or matching a declared secret are written as `secret` references. The person adds `Expect` lines with criterion ids through a picker.
  - **Route f, core's own chatbot (P2b, paid).** A conversational drafter on a core-hosted model, offered with hosted history (SPEC-24). It replies with drafts only; its AI egress is in the logging manifest and the data processing agreement.
- **Non-goals:**
  - any route that approves, runs gated or edits trusted files;
  - AI at run time (runs replay with no inference);
  - a second grammar or parser for any route;
  - free-text steps, CSS, XPath or script (SPEC-01);
  - carrying `#` comments into JSON (open question: they are dropped with a `comment-dropped` warning in v1).

## Interfaces and types

```
Readable grammar v1 (statements are case-insensitive; writePlanText prints them as shown)

Plan: <name>                                   header, required
Version: 1.1                                   header, required
Targets: <target>[, <target>]                  header, required
Origin: <origin>                               header, optional; "Go to /path" resolves against it
Criterion: <criterion id>                      sets the criterion id of the Expect lines that follow

Go to <absolute url | /path>
Click <locator>                                Hover <locator>
Type "<text>" into <locator>                   Type secret <SECRET_NAME> into <locator>
Select "<option>" in <locator>                 Upload fixture "<fixture>" to <locator>
Press <Key> in <locator>                       Accept dialog | Dismiss dialog [expecting "<text>"]
In frame <locator>:                            the frame's steps follow, indented two spaces
Expect <locator> is visible|hidden|absent|enabled|disabled|checked|unchecked|focused
Expect <locator> has text|value ["containing"] "<text>"
Expect <locator> count is <integer>
Expect page URL is "<url>"                     Expect page title is "<text>"
Check accessibility as gate|report             Capture "<name>"

<locator> = <role> ["<name>"] | label "<text>" | text "<text>" | test id "<id>"
<role>    = a Role from the shared types, e.g. button, link, textbox, heading
Strings are double-quoted; \" and \\ are the only escapes. Blank lines are ignored.

Example:
  Plan: Sign in
  Version: 1.1
  Targets: chromium-stable
  Origin: https://staging.example.org
  Go to /login
  Type secret TEST_USER into textbox "Email"
  Click button "Sign in"
  Criterion: AC-3
  Expect heading "Dashboard" is visible
```

```ts
// Plan, PlanData, PlanError, PlanLimits and parseAiText: SPEC-01. Result, Brand, Origin, TargetId, Role,
// EventSink and DerivedActor: SPEC-27. SecretName: SPEC-04. CriterionId: SPEC-01.
export type PlanSource = 'hand-written' | 'customer-llm' | 'draft-command' | 'ticket' | 'builder' | 'recorder' | 'chat';
// core-recorded: core produced the draft. declared: an author named the source of a file; never checked or trusted.
export type ProvenanceBasis = 'core-recorded' | 'declared';
export type PlanProvenance = {
  readonly source: PlanSource; readonly basis: ProvenanceBasis;
  readonly reference?: string;                     // spec path, issue id or session id; never content
};
export type PlanFormat = 'json' | 'text';
// What every route produces: text, never a Plan. Only parsePlan makes a Plan.
export type PlanDraft = { readonly format: PlanFormat; readonly content: string; readonly provenance: PlanProvenance };

export type TextPosition = { readonly line: number; readonly column: number };          // 1-based
export type TextErrorCode = 'unknown-statement' | 'bad-locator' | 'bad-string' | 'bad-indent' | 'missing-header'
  | 'duplicate-header' | 'no-criterion' | 'relative-url-without-origin' | 'unknown-key-name' | 'too-large';
// Text errors and the parser's errors, each placed by line and column; neither echoes a value.
export type DraftError =
  | { readonly stage: 'text'; readonly code: TextErrorCode; readonly position: TextPosition }
  | { readonly stage: 'plan'; readonly code: PlanErrorCode; readonly path: string; readonly position: TextPosition | null };
export type TextWarning = { readonly code: 'comment-dropped'; readonly position: TextPosition };
// Reading text gives plain JSON for the plan parser, plus the line each JSON path came from.
export type TextReading = {
  readonly json: unknown; readonly positions: ReadonlyMap<string, TextPosition>; readonly warnings: readonly TextWarning[];
};
export type PlanParse = (input: unknown) => Result<Plan, readonly PlanError[]>;          // what planParser(project) returns
export function readPlanText(text: string, limits: PlanLimits): Result<TextReading, readonly DraftError[]>; // pure; never a Plan
export function writePlanText(plan: Plan): string;    // pure; canonical text
export function writePlanJson(plan: Plan): string;    // pure; canonical JSON: fixed key order, two-space indent, LF, final newline
export function planHash(plan: Plan): string;         // SHA-256 of writePlanJson(plan); the approval subject (SPEC-02)
// The one door from a draft to a Plan for every route. Appends plan.submitted or plan.rejected with the provenance.
export function admitDraft(draft: PlanDraft, parsePlan: PlanParse, events: EventSink, actor: DerivedActor)
  : Result<Plan, readonly DraftError[]>;

// Route c: the draft command.
export type CriterionText = { readonly criterion: CriterionId; readonly text: string };
export function extractCriteria(markdown: string): Result<readonly CriterionText[], { readonly code: 'no-criteria' }>; // pure
// Everything the planner may see.
export type DraftRequest = {
  readonly criteria: readonly CriterionText[]; readonly grammarVersion: string;
  readonly origins: readonly Origin[]; readonly targets: readonly TargetId[];
};
export interface AiPlanner { propose(request: DraftRequest): Promise<unknown> }       // untrusted output
export type PlannerEndpoint =
  | { readonly kind: 'customer-key'; readonly url: string; readonly model: string; readonly apiKey: { readonly secretName: SecretName } }
  | { readonly kind: 'local'; readonly url: string; readonly model: string };          // loopback address only
export type DraftCommandResult = {
  readonly draftPath: string; readonly provenance: PlanProvenance;
  readonly errors: readonly DraftError[]; readonly approved: false;
};

// Route d (phase 2a): reads one section of a ticket through the read-only tracker connector (SPEC-20).
export interface TicketCriteriaReader {
  criteria(issueId: string): Promise<Result<readonly CriterionText[], { readonly code: 'not-found' | 'no-criteria-section' | 'read-failed' }>>;
}
// Routes e and f (phase 2b). Each returns drafts only.
export interface PlanBuilder { serve(port: number): Promise<{ readonly url: string; close(): Promise<void> }> } // loopback only
export interface PlanRecorder { record(target: TargetId): Promise<PlanDraft> }       // a person drives a visible browser
export interface ChatDrafter { reply(conversationId: string, message: string): Promise<PlanDraft> } // hosted, paid
```

## Acceptance criteria

- AC-SPEC-28-01: When any plan in canonical JSON form is converted to text with `writePlanText` and back through `readPlanText`, `parsePlan` and `writePlanJson`, the output shall be byte-identical to the input. This holds for every golden example and for generated plans covering every step, locator and assertion kind (oracle: metamorphic; property test).
- AC-SPEC-28-02: When readable text is read, parsed and written back with `writePlanText`, the result shall equal the canonical text, and doing it twice shall give byte-identical output (oracle: metamorphic).
- AC-SPEC-28-03: When a draft from each `PlanSource` (a fixture per route) reaches a run, `parsePlan` shall have been called on it first, and the driver, network and policy-gate spies shall record no call before that parse. A test enumerates every `PlanSource` value, so a new source without a fixture fails the build (oracle: specified).
- AC-SPEC-28-04: When route code (draft command, ticket reader, builder, recorder, chat, MCP handler) is compiled, it shall not import `run` or the brand constructor, and its outputs shall be typed `PlanDraft`; lint fails otherwise (oracle: specified).
- AC-SPEC-28-05: When readable text has an error, each error shall give its code, line and column, a parser error shall be mapped back to the line of its JSON path, and no error shall contain an input value (oracle: specified).
- AC-SPEC-28-06: When the founder's example plan above is read, it shall parse to the expected JSON golden file, with `Go to /login` resolved against the `Origin:` header and a `fill` step carrying `{ secretName: 'TEST_USER' }` (oracle: specified).
- AC-SPEC-28-07: When the same plan is approved in one form, the other form and any re-layout of it shall have the same `planHash`, and the approval shall still apply; any change to a step shall change the hash (oracle: specified).
- AC-SPEC-28-08: When `admitDraft` runs, it shall append one `plan.submitted` or `plan.rejected` event carrying the draft's source and basis. The same plan submitted under each source shall get the same policy decision and approval requirement (oracle: specified).
- AC-SPEC-28-09: When a file is validated without a declared source, its provenance shall be `hand-written` with basis `declared`. A file can never claim a `core-recorded` basis (oracle: specified).
- AC-SPEC-28-10: When `core draft` runs on a spec with criteria, it shall write a readable draft with source `draft-command`, report its errors by line, and leave it unapproved. With a recorded planner response, the output shall be byte-identical across runs (oracle: regression).
- AC-SPEC-28-11: When `core draft` calls the planner, the request shall contain only the criteria text, grammar version, origins and targets. A seeded secret, page text and artefact path shall be absent from the request body (oracle: specified).
- AC-SPEC-28-12: When the planner returns non-text, script-bearing or over-long output, the draft shall not be written and the command shall report `plan-rejected` (oracle: specified; reuses AC-SPEC-01-09).
- AC-SPEC-28-13: When the ticket route reads a fixture issue (phase 2a), it shall take only the configured criteria section, use read-only scopes, and record the issue id as the provenance reference (oracle: specified).
- AC-SPEC-28-14: When the plan builder validates text (phase 2b), it shall use the same reader and parser build as the CLI (equal source hashes). The report HTML shall still contain no script (oracle: specified).
- AC-SPEC-28-15: When the recorder captures typing into a password field or a value equal to a declared secret (phase 2b), the draft shall hold a `secret` reference and the value shall appear in no file or event (oracle: specified; seeded canary).
- AC-SPEC-28-16: When the chat drafter replies (phase 2b), it shall return a draft only. Its egress shall be listed in the logging manifest, and no chat session shall be able to approve a plan or decide a review item (oracle: specified).

## Dependencies

- SPEC-01 (`planParser`, `PlanData`, `parseAiText`), SPEC-02 (approval of the plan hash), SPEC-03 (policy gate), SPEC-04 (secret names), SPEC-09 (logging manifest), SPEC-14 (audit log), SPEC-16 (`draft` and `convert` commands), SPEC-27 (`planSource` on events).
- Phase 2: SPEC-18 (MCP accepts both forms), SPEC-20 (tracker connector), SPEC-24 (hosted chat).
- The core skeleton's `AiPlanner` port and AI-text module (spike P3), copied with source hashes.
- Founder decision of 2026-10-27: every workflow route, all mapping to one typed plan.
- Research background: architecture (`04` Finding 3, the AI containment pipeline). Schema adherence is not correctness [C-R13-045].

## Milestone

M1 (readable format, conversion, `admitDraft`, provenance); M4 (`draft`); phase 2a (MCP text input, tickets); phase 2b (builder, recorder; chat, paid).

## Satisfies

FR-44, FR-45, FR-46, FR-47, FR-48
