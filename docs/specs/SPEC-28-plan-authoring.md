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

### Readable syntax for plan 1.2 (addition, 2026-10-28)

**In short.** Every construct of plan language 1.2 gets one readable form here. So do the 1.1 constructs the grammar above leaves out: the `urlPath` check, `storageState` and the meta headers. The reader only turns lines into plain JSON fields, and `parsePlan` alone decides what is allowed. So a 1.2 statement in a `Version: 1.1` plan is read as usual and then refused with the code a 1.1 parser gives. As in JSON, nothing in the text can express script, CSS, XPath, a pattern or a sleep. The rules below hold for the 1.1 statements too.

**Writing text exactly.**

- **Lines.** `writePlanText` writes LF line ends and a final newline. The reader also accepts CRLF and drops a byte-order mark at the start, because Windows editors may write both. Spaces at the end of a line are ignored. The writer puts one space between tokens; the reader accepts several.
- **Blocks.** Only four statements open a block: `Values:`, `Clean up:`, `In frame …:` and `In new tab at …:`. Their lines follow, indented two spaces more. Indentation is spaces only; any other indentation is `bad-indent`. Blank lines and comment lines may stand anywhere, inside blocks too, and they neither open nor close a block.
- **Case.** Grammar words are case-insensitive: statement words, roles, keys, modifiers, position words, states, units, anchors, formats, `secret`, `true` and `false`. The writer prints them as shown. Names, ids, URLs and quoted text are kept exactly as written.
- **Quoted text** (`"…"`) holds page-facing text exactly.
  - Inside the quotes these are ordinary characters: spaces at either end, `#`, braces, commas, colons, `/`, words the grammar uses, and letters outside ASCII.
  - `\"` and `\\` are the only escapes. The writer escapes every `"` and `\`, and nothing else.
  - Plan text never holds a line break or a tab, because the parser refuses control characters as `unsafe_text`. So quoted text always closes on its own line. Text of several lines is written with `lines`.
  - An unclosed string, or any other escape, is `bad-string`.
- **Value references.** `{name}` is a value name in braces, with no spaces. It may stand wherever quoted text stands in a step, and it reads as `{ "valueName": "name" }`. The parser decides where a reference is allowed: anywhere else it is `wrong_type`, and before its definition it is `undefined_value`. `"{name}"` inside quotes is literal text. A malformed reference is `bad-string`.
- **Bare words.** Names a plan refers to are written without quotes:
  - value names;
  - the project's names for calls, parameters, fields, stubs, requests and storage entries;
  - secret names, test-id attributes, email domains and query keys;
  - criterion, feature and target ids.

  A bare word is a run of characters other than space, `"`, `{`, `}` and `,`. The reader copies it as it is, and the parser checks it against its pattern or the project's declarations.
- **Numbers** are written as JSON writes them, for example `2`, `-5`, `0.5` or `1e+21`. The reader accepts JSON number syntax, and the parser decides where only a whole number will do. Only positions are written differently, as words or ordinals (below).
- **URLs.**
  - The URL after `Go to` or `In new tab at` is a bare word. The parser keeps it percent-encoded, so it holds no space and no `"`.
  - An `Origin:` header resolves a path in either statement, as the Build notes say for `Go to`. It never touches a path template.
  - Every URL or path that a check compares is quoted text, because checks keep what they are given.
- **Header text.** `Plan:` and `Spec:` take the rest of the line as it stands. If the text starts or ends with white space, or starts with `"`, it is written as quoted text instead. Headers hold no references, so `{` there is an ordinary character.
- **Absent and empty.** Where JSON tells an absent field from an empty one, the text does too. Leaving the words out leaves the field out.

  | Text | JSON |
  |---|---|
  | `Values:` with no definitions under it | `"values": {}` |
  | `Clean up:` with nothing under it | `"cleanup": []` |
  | `with no arguments` | `"arguments": {}` |
  | `remembering nothing` | `"remember": {}` |
  | `with empty query` | `"query": {}` |
- **Names given twice.** JSON can't hold one key twice. So a name written twice in `Values:`, in one argument list, in one query or in one `remembering` list is the new text error `duplicate-key`, at the second one. Reusing a name elsewhere in the plan stays the parser's `duplicate`.
- **Placement.**
  - Headers other than `Criterion:` come before the first step, in any order. Such a header after the first step is `unknown-statement`.
  - `Clean up:` comes last. Any statement after its block is `unknown-statement`.
  - A step inside `Clean up:` other than `Call` still reads into `cleanup`, and the parser refuses it with `misplaced_step`. A `newTab` inside a frame is refused the same way.
- **Criteria.**
  - Every check statement starts with `Expect`, and only check statements do.
  - `Criterion:` may stand wherever a step may. It sets the criterion id of every `Expect` line after it in reading order, inside or outside blocks, until the next `Criterion:`.
  - The writer puts a `Criterion:` line directly before a check, at the check's own indentation, whenever the check's id differs from the one in force.
  - A check's `criterionId` path maps to its `Criterion:` line, so a parser error about it is reported on that line.

```
Readable grammar v1: the plan 1.2 addition (it reads plans of version 1.1 too)

Headers, written in this order
Plan: <header text>                            meta.title
Feature: <feature id>                          meta.featureId
Spec: <header text>                            meta.specReference
Version: 1.2                                   or 1.1
Targets: <target>[, <target>]
Saved session: secret <SECRET_NAME>            storageState (language 1.1)
Clock: <day> at <HH:MM>                        clock
Values:                                        values: one definition per line follows, indented two spaces
  <name> is unique text starting "<prefix>"
  <name> is unique email starting "<prefix>" [at <domain>]       without "at", domain is left out
  <name> is unique number of <number> digits
  <name> is date <day> as <format>

<day>      = <anchor> | <n> day[s] after <anchor> | <n> day[s] before <anchor>   <n> is digits
<anchor>   = today | start of week | start of month | start of next month
             The writer writes addDays 0 as the anchor alone, 1 as "1 day" and others as "<n> days".
<format>   = year-month-day | day of month | month and year | long date | weekday | timestamp | epoch milliseconds

Locators and text
<locator>  = [<position>] <role> <text> | [<position>] label <text> | [<position>] text <text>
           | [<position>] test id <text> [in attribute <attribute>]
<position> = first | last | <n>st | <n>nd | <n>rd | <n>th
             "first" is "position": "first"; "1st" is "position": 1. The suffix must be the English one
             (1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st, 101st); any other suffix is bad-locator.
<text>     = "<quoted text>" | {<value name>}
In the 1.1 statements above, every "<text>" may also be a {reference} in a 1.2 plan, and every
<locator> may take a position and an attribute. Without "in attribute", attribute is left out.

Steps
Go to <url> [without scripts]                  "scripts": "disabled"
Go to <path template> [without scripts]
<path template> = path <text>[ / <text>]... [with query <key> <text>[, <key> <text>]... | with empty query]
Type lines <text>[, <text>]... into <locator>  "value": { "lines": [ … ] }
Press [<modifier>+]...<key> in <locator>       e.g. Press Control+Shift+Backquote; modifiers in the order held
Download "<name>" by clicking <locator>
In new tab at <url | path template>:           the tab's steps follow, indented two spaces
Remember text|value of <locator> as <name>     from an element: "read": "text" | "value"
Remember text|length of field <field> in response <request> as <name>   "read": "text" | "arrayLength"
Remember clipboard text as <name>
Call <call> [with <arguments>] [remembering field <field> as <name>[, field <field> as <name>]... | remembering nothing]
                                               without "with", arguments is {}
Clean up:                                      cleanup: its calls follow, indented two spaces
Start stub <stub> [with <arguments> | with no arguments]
Stop stub <stub>
Reset requests <request>
Set storage entry <entry> [with <arguments> | with no arguments]
Remove storage entry <entry>
Advance clock by <number> <unit> [running timers | skipping ahead]      without either, mode is left out
<unit>      = millisecond[s] | second[s] | minute[s] | hour[s] | day[s]   the writer uses the singular for 1
<arguments> = <parameter> <argument>[, <parameter> <argument>]...       the writer keeps the declaration's order
<argument>  = <text> | <number> | true | false | secret <SECRET_NAME>

Checks, each with the criterion id of the Criterion: line before it
Expect <locator> is selected|unselected|expanded|collapsed|pressed|unpressed|current
Expect <locator> links to <text>               hrefEquals
Expect page path is "<path>"                   urlPath (language 1.1)
Expect page path starts with "<path>"          urlPathStartsWith
Expect page meta "<name>" is <text>            metaContent
Expect page canonical URL is "<url>"           canonicalUrl
Expect download "<name>" file name is <text>
Expect download "<name>" media type is "<media type>"
Expect download "<name>" size is at least|at most <number> byte[s]
Expect download "<name>" contains|does not contain <text>
Expect backend <call> [with <arguments>] field <field> is present|absent
Expect backend <call> [with <arguments>] field <field> is <text> | contains <text> | is number <number>
Expect requests <request> count is [at least|at most] <number>
Expect response <request> status is <number>
Expect response <request> field <field> is present|absent | is <text> | contains <text>
Expect storage entry <entry> is present|absent | is <text>
Expect clipboard text is <text> | text is lines <text>[, <text>]...
Expect clipboard contains|does not contain <text>
```

**Decisions.**

- **One text per JSON value.** Every pair of JSON values that could look alike gets different words:
  - text against a reference: `"x"` and `{x}`;
  - one line against several: `"x"` and `lines "x"`;
  - text against a number or a boolean: `"2"`, `2` and `true`;
  - a text check against a number check: `is "42"` and `is number 42`;
  - a URL against a path template: `/a/b` and `path "a" / "b"`;
  - a position word against a number: `first` and `1st`;
  - a mode, scripts setting, domain, attribute or modifier left out against one that is written.
- **Quoted or bare.** Text the page shows is always quoted. Names whose pattern excludes spaces and quotes are bare.
- **The two map-shaped forms.** Query values and arguments are written `<name> <value>`. A list of them ends at a word that can't be a value, such as `remembering`, `field` or `without`. So a parameter that happens to be named after a grammar word is still read correctly.
- **The writer's choices** that the reader does not need:
  - singular units for 1;
  - `today` for addDays 0;
  - arguments in the declaration's order, which is the parser's own order;
  - query values and remembered fields in their JSON order.

**Risks.**

- Strings holding a lone surrogate (half of a UTF-16 pair) pass the parser and survive the round trip in memory, but not in a UTF-8 file. The parser could refuse them as `unsafe_text`.
- `DraftRequest.grammarVersion` still says `v1`, although the grammar now covers 1.2.

**Golden plans as text.** One line or more per 1.2 feature, from the golden plan that uses it (`golden/plans/`). The 1.1 golden plans need only the grammar above, the meta headers and `Expect page path is`; for example, `account-closure` has `Expect page path is "/goodbye"`.

| Feature | Golden plan | Text |
|---|---|---|
| Generated values | `unique-sign-up` | `displayName is unique text starting "Tester"`, `contact is unique email starting "ada"`, `memberNumber is unique number of 8 digits` and `trialEnds is date 14 days after today as long date`, under `Values:` |
| References in fills and checks | `unique-sign-up` | `Type {contact} into label "Email"`; `Expect test id "echo" has text containing {contact}` |
| Reference in a locator | `remembered-order-number` | `Expect row {orderNumber} is visible` |
| Path template | `order-page-by-path` | `Go to path "orders" / {orderCode} with query tab "items", highlight {orderCode}` |
| Positions | `third-search-result` | `Expect first link "Install" is visible`; `Expect last listitem "Result" is visible`; `Click 3rd link "Install"` |
| Test-id attribute | `declared-test-id-attribute` | `Click test id "save-settings" in attribute data-testid` |
| Key chords | `keyboard-shortcuts` | `Press ControlOrMeta+k in main "Editor"`; `Press Control+Shift+Backquote in main "Editor"` |
| Multi-line fill | `long-chat-message` | `Type lines "First line of the message", "Second line", "Third line" into textbox "Message"` |
| URL prefix | `project-pages-prefix` | `Expect page path starts with "/projects/demo/"` |
| Page states | `page-states` | `Expect tab "Billing" is selected`; `Expect button "Invoices" is collapsed`; `Expect button "Paperless billing" is pressed`; `Expect link "Settings" is current` |
| Link target | `link-target` | `Expect link "Billing guide" links to "http://127.0.0.1:4173/help/billing"` |
| Scripts-off load, metadata | `server-rendered-metadata` | `Go to /events/team-meeting without scripts`; `Expect page meta "og:title" is "Team meeting"`; `Expect page canonical URL is "http://127.0.0.1:4173/events/team-meeting"` |
| Downloads | `export-download` | `Download "project-list" by clicking button "Export CSV"`; `Expect download "project-list" media type is "text/csv"`; `Expect download "project-list" size is at least 1 byte`; `Expect download "project-list" does not contain "Archived pilot"` |
| Second tab | `second-tab-session` | `In new tab at /account:`, then indented `Criterion: account.second-tab-signed-in` and `Expect heading "Your account" is visible` |
| Stubs | `login-code-stub` | `Start stub loginNeedsCode with reason "Enter the code from your app"`; `Stop stub loginNeedsCode` |
| Request checks | `like-requests-and-response` | `Reset requests likes`; `Expect requests likes count is at least 1`; `Expect response likes status is 200`; `Expect response likes field errorCode is absent`; `Expect response likes field firstLiker contains "Ada"` |
| Remember from a response | `like-requests-and-response` | `Remember length of field likeList in response likes as likeCount`; `Remember text of field firstLiker in response likes as firstLikerName` |
| Storage | `pinned-menu-storage` | `Set storage entry pinnedMenu with docked true`; `Expect storage entry pinnedMenu is "true"`; `Expect storage entry privateKey is present`; `Remove storage entry pinnedMenu` |
| Clock advance | `session-expiry-clock` | `Advance clock by 599 seconds`; `Advance clock by 1 second running timers`; `Advance clock by 45 minutes skipping ahead` |
| Clipboard checks | `copied-invite-link` | `Expect clipboard contains "/invite/"`; `Expect clipboard does not contain "password"`; `Expect clipboard text is lines "Analytical Engines Ltd", "12 Babbage Row", "London"` |
| Remember from the clipboard and the page | `remembered-copied-link`, `remembered-order-number` | `Remember clipboard text as shareLink`; `Remember text of test id "order-number" as orderNumber` |

The plan clock and run values (`booking-next-month`), then service calls, `expectBackend` and `cleanup` (`order-backend-state`), in full:

```
Plan: The first slot of the month can be booked
Feature: BOOKING-1
Spec: specs/booking.md#first-slot
Version: 1.2
Targets: playwright-chromium
Clock: start of next month at 09:00
Values:
  slotDay is date start of next month as day of month
  slotMonth is date start of next month as month and year
Go to /booking
Criterion: booking.month-shown
Expect heading {slotMonth} is visible
Click button {slotDay}
Criterion: booking.day-selected
Expect test id "selected-day" has text {slotDay}
```

```
Plan: A new order is paid in the backend and cleaned up
Feature: ORDERS-3
Spec: specs/orders.md#backend-state
Version: 1.2
Targets: playwright-chromium
Call createOrder with customerName "Ada Lovelace", contactEmail "ada@example.com", quantity 2, region "eu", giftWrap false, deliveryDay "2026-11-02" remembering field orderId as orderId
Go to path "orders" / {orderId}
Click button "Confirm order"
Criterion: orders.paid-in-backend
Expect backend getOrder with orderId {orderId} field status is "paid"
Clean up:
  Call deleteOrder with orderId {orderId}
```

*End of the plan 1.2 addition. The types follow.*

```ts
// Plan, PlanData, PlanError, PlanLimits and parseAiText: SPEC-01. Result, Brand, Origin, TargetId, Role,
// EventSink, SinkError and DerivedActor: SPEC-27. SecretName: SPEC-04. CriterionId: SPEC-01.
export const PLAN_SOURCES = ['hand-written', 'customer-llm', 'draft-command', 'ticket', 'builder', 'recorder', 'chat'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];
export const DECLARABLE_PLAN_SOURCES = ['hand-written', 'customer-llm'] as const;
// core-recorded: core produced the draft. declared: an author named the source of a file; never checked or trusted.
export type ProvenanceBasis = 'core-recorded' | 'declared';
export type PlanProvenance = {
  readonly source: PlanSource; readonly basis: ProvenanceBasis;
  readonly reference?: string;                     // spec path, issue id or session id; never content
};
export type PlanFormat = 'json' | 'text';
// What every route produces: text, never a Plan. Only parsePlan makes a Plan. `provenance` is the
// declared source; left out, the draft is hand-written, basis declared. Only hand-written and
// customer-llm may be declared (DECLARABLE_PLAN_SOURCES); anything else is refused as untrusted-source.
export type PlanDraft = { readonly format: PlanFormat; readonly content: string; readonly provenance?: PlanProvenance };

export type TextPosition = { readonly line: number; readonly column: number };          // 1-based
export type TextErrorCode = 'unknown-statement' | 'bad-locator' | 'bad-string' | 'bad-indent' | 'missing-header'
  | 'duplicate-header' | 'no-criterion' | 'unknown-key-name' | 'too-large' | 'duplicate-key';
// Text errors and the parser's errors, each placed by line and column (a JSON draft's parser errors
// have no lines); none echoes a value. A refused source claim and an unrecorded submission have no place.
export type DraftError =
  | { readonly stage: 'text'; readonly code: TextErrorCode; readonly position: TextPosition }
  | { readonly stage: 'plan'; readonly code: PlanErrorCode; readonly path: string; readonly position: TextPosition | null }
  | { readonly stage: 'source'; readonly code: 'untrusted-source'; readonly position: null }
  | { readonly stage: 'audit'; readonly code: SinkError['code']; readonly position: null };
export type TextWarning = { readonly code: 'comment-dropped'; readonly position: TextPosition };
// Reading text gives plain JSON for the plan parser, plus the line each JSON path came from.
export type TextReading = {
  readonly json: unknown; readonly positions: ReadonlyMap<string, TextPosition>; readonly warnings: readonly TextWarning[];
};
export type PlanParse = (input: unknown) => Result<Plan, readonly PlanError[]>;          // what planParser(project) returns
export function readPlanText(text: string, limits: PlanLimits): Result<TextReading, readonly DraftError[]>; // pure; never a Plan
export function writePlanText(plan: Plan): string;    // pure; canonical text
// pure; canonical JSON: canonicalJson's key order (sorted), two-space indent, LF, final newline
export function writePlanJson(plan: Plan): string;
export function planHash(plan: Plan): string;         // SHA-256 of canonicalJson(plan), as built; the approval subject (SPEC-02)
// The one door from a draft to a Plan for every route. Appends plan.submitted or plan.rejected with
// the provenance (EventInput.planProvenance); a refused source claim is recorded without it.
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

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; `docs/decisions/answers.md`):

- **Plan 1.2 in text (addition).** The readable grammar above covers plan 1.1. Every 1.2 feature (SPEC-30 to 34) gets a readable form, defined in "Readable syntax for plan 1.2" above. That way AC-SPEC-28-01's round trip holds for every golden plan.
- **Plan header.** `Plan:` fills `meta.title`. New headers `Feature:` and `Spec:` fill `meta.featureId` and `meta.specReference`; a plan needs both to parse. The founder's example has neither, so AC-SPEC-28-06 compares version, targets and steps only.
- **URLs.** `Go to <url>` keeps exactly what it is given. With an `Origin:` header, a path is resolved against it to an absolute URL (AC-SPEC-28-06). Without one, a path stays a path, as JSON allows. The canonical writer never writes `Origin:`, so text and JSON round-trip byte for byte.
- **Plan hash.** It stays the built formula, the sha256 of `canonicalJson` (`packages/engine/src/manifest.ts`), so existing hashes and the replay golden don't change. `writePlanJson` is the file form, not the hash input.
- **Provenance.** `EventInput` gains `planProvenance`, and the JSON Lines sink writes it.
- **Declared sources (AC-SPEC-28-09).** `admitDraft` takes an optional declared source. Without one, provenance is `hand-written` with basis `declared`. Only core's recorder (phase 2b) can produce a `core-recorded` basis; a file or a caller that claims it is refused with `untrusted-source`.
- **Malformed JSON drafts** are refused with `not_object` at `$`, before the parser.
- **Criterion ids in data.** The naming lint skips the values of `criterionId` fields, because they are the user's own ids, such as `AC-3`.
- **Codes.** `TextErrorCode` gains `duplicate-key`, for a name written twice where JSON needs a key once. `relative-url-without-origin` no longer arises, because a path without `Origin:` stays a path, so it leaves the union.
- **Lone surrogates.** Text holding half of a UTF-16 pair is refused as `unsafe_text` by the one plan parser, because it can't survive being saved as UTF-8.
- **Grammar version.** `grammarVersion` stays `"v1"` until the readable format's first release; the 1.2 forms are part of v1.
- **Text errors.** A statement's own error is at column 1, and any other inside the faulty token. Comments are whole lines starting with `#`.

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
