# SPEC-37: Explore the page to draft a plan

## Purpose

Let a person point Revisum at their running app and get a draft plan back, with no acceptance criteria written first. Many teams building with AI have no written criteria, so SPEC-28's route c (`revisum draft --from <spec.md>`) leaves them hand-writing plans (founder, 2026-10-29). It serves "AI writes features faster than we can check them" (UP-01): checks are drafted from the app itself. It keeps "letting AI agents into our pipeline feels like handing over the keys" (UP-09) answered: **AI never drives the browser.** A deterministic crawl reads the pages, the AI sees only a bounded, redacted page map and writes text, and that text is a draft like any other. It goes through `admitDraft`, `parsePlan`, the policy gate and a person's approval (SPEC-28, SPEC-01 to 03). Runs replay with no inference.

## Scope and non-goals

- **In:**
  - **`revisum draft --explore <url>`.** A mode of SPEC-28's `draft` command. It can be combined with `--from <spec.md>`: criteria plus page map give the best drafts. Without `--from`, the planner drafts checks of what the pages show now.
  - **Deterministic crawl, no AI.**
    - Headless Chromium through the own CDP driver (SPEC-06), in the isolated runner (SPEC-07) with egress limited to the project's declared origins.
    - It starts at the given URL, which must be on a declared origin that is not in `productionOrigins`.
    - It only navigates. It reads each page's accessibility tree, title and same-origin link targets, and follows links breadth first, sorted, up to `maxPages` and `maxDepth`. It never clicks, types, selects, submits or runs page scripts.
    - **Logging in first.** `--after <plan>` runs an approved plan through the normal gated path before the crawl, in the same browser context. An unapproved plan is refused before any browser starts.
    - **Host mode.** Without the isolated runner the command refuses, unless `--host` is given. Then the crawl runs on the host, the page map says `guaranteeLevel: 'host'`, and the output says egress was not enforced.
  - **Page map, pure and bounded** (`engine`).
    - Per page: the URL path (no query or fragment), title, crawl depth, and an outline of the accessibility tree with role and accessible name only.
    - Kept roles: landmarks, headings, links, buttons, form controls, lists, tables, dialogs, tabs and menus. Text-content roles (static text, paragraphs) are dropped. Form-control values are never read.
    - Names are cut to 80 characters. Declared secrets are redacted (SPEC-04). Email, phone and card-number shapes become `[redacted]` until SPEC-09's PII pass replaces this rule.
    - The same site gives a byte-identical page map, which is written to the draft folder beside the draft. Its sha256 is the draft's provenance reference.
  - **Planner request.** `DraftRequest` gains `pages`. The planner sees only the criteria (if any), grammar version, declared origins and targets, and the page map. It never sees cookies, storage, screenshots, DOM text, typed values or artefact paths. Page text is untrusted and is passed as quoted data in a fixed prompt kept in code.
  - **Planner adapters** (`cli`, shared with SPEC-28's route c and built with it).
    - Two wire formats over Node's `fetch`, with no SDK and no new dependency: Anthropic Messages, and OpenAI-compatible chat completions. The second also covers local servers such as Ollama and LM Studio.
    - The API key is a secret reference resolved at call time, redacted from every output and error.
    - A `local` endpoint must be a loopback address.
  - **Draft output.**
    - Model output is `unknown`, bounded by `parseAiText` (SPEC-01) and admitted through `admitDraft` with source `explore-draft`, basis `core-recorded`. It is written as readable text with its errors by line, and never approved or run by the command.
    - The command writes a fixed notice at the top of the draft, not the model: the draft checks what the pages do now, which may include bugs, so review each `Expect` line.
    - **Locator check, static.** For steps after a `Go to` and before the first step that may change the page (click, press, select, upload, dialog), each role or label locator is matched against that page's map. Misses and multiple matches are warnings by line (`locator-not-on-page`, `locator-ambiguous`). Later steps are not checked.
    - To try a draft, the person runs it. An unapproved plan runs as a proposal run on non-production origins (SPEC-02).
  - **Reuse.** SPEC-26's exploration mode reuses this crawl and page map later.
- **Non-goals:**
  - AI choosing actions or driving the browser, during the crawl or at run time;
  - crawling production origins;
  - clicking, typing or submitting during the crawl;
  - screenshots, DOM text or network data in the planner request;
  - approving, running or editing trusted files from the command;
  - repairing a plan after the UI changes (later, as a separate draft route);
  - crawling more than one origin per command.

## Interfaces and types

```ts
// contracts: PLAN_SOURCES gains 'explore-draft' (basis core-recorded; never declarable).

// contracts: the driver port gains one read-only method. Absolute URLs of the current frame's links.
// OwnBrowserDriver.linkTargets(): Promise<readonly string[]>

export type ExploreOptions = {
  readonly start: string;                 // absolute URL on a declared, non-production origin
  readonly maxPages: number;              // default 20, at most 100
  readonly maxDepth: number;              // default 3, at most 5
  readonly pageTimeoutMs: number;         // default 15000
  readonly placement: 'isolated' | 'host';
};
export type PageMapNode = { readonly role: string; readonly name: string; readonly children: readonly PageMapNode[] };
export type PageMapEntry = {
  readonly path: string; readonly title: string; readonly depth: number; readonly tree: readonly PageMapNode[];
};
export type PageMap = {
  readonly origin: Origin; readonly pages: readonly PageMapEntry[];
  readonly truncated: boolean;            // true when maxPages or maxDepth stopped the crawl
  readonly guaranteeLevel: GuaranteeLevel;
};
export type ExploreErrorCode =
  | 'explore-origin-refused'              // start URL not declared, or a production origin
  | 'after-plan-unapproved'               // --after names a plan without an approval for its hash
  | 'explore-runner-unavailable'          // no isolated runner and no --host
  | 'planner-endpoint-not-loopback'       // a local endpoint off the loopback interface
  | 'planner-call-failed';                // network or status failure; never echoes the body or key

// engine, pure: page map from one page's tree; redaction and the role filter live here.
export function pageMapEntry(tree: A11yNode, url: string, title: string, depth: number, redact: Redactor): PageMapEntry;
// engine: the crawl, with the driver injected. Navigation and reads only.
export function crawlSite(driver: ExploreDriver, project: TrustedProject, options: ExploreOptions)
  : Promise<Result<PageMap, { readonly code: ExploreErrorCode }>>;
export type ExploreDriver = Pick<OwnBrowserDriver, 'navigate' | 'accessibilityTree' | 'title' | 'linkTargets'>;
// engine, pure: the static locator check.
export type DraftWarning = { readonly code: 'locator-not-on-page' | 'locator-ambiguous'; readonly position: TextPosition };
export function checkDraftLocators(plan: Plan, reading: TextReading, map: PageMap): readonly DraftWarning[];

// SPEC-28 additions.
// DraftRequest gains: readonly pages?: readonly PageMapEntry[]; criteria may be empty when pages are given.
// PlannerEndpoint gains: readonly wire: 'anthropic-messages' | 'openai-chat'.
// DraftCommandResult gains: readonly pageMapPath?: string; readonly warnings: readonly DraftWarning[];
//   readonly egressEnforced: boolean.
```

```
revisum draft --explore <url> [--from <spec.md>] [--after <approved.plan>] [--max-pages 20] [--max-depth 3]
              [--host] --out plans/<name>.plan [--json]
```

`ExploreDriver` names methods the CDP driver has or gains. Where the built driver names them differently, the code follows the driver, as a marked addition.

## Acceptance criteria

- AC-SPEC-37-01: When the start URL is on an undeclared origin or in `productionOrigins`, the command shall stop with `explore-origin-refused` before any browser starts. During a crawl, a link to another origin shall never be followed (oracle: specified; fixture site with cross-origin and production links).
- AC-SPEC-37-02: When a crawl runs, the driver spy shall record only navigation, accessibility-tree, title and link-target calls, plus the calls of an approved `--after` plan. It shall record no click, type, select, upload, key press, dialog answer or page script (oracle: specified).
- AC-SPEC-37-03: When a fixture site is crawled, the page map shall hold at most `maxPages` pages, none deeper than `maxDepth`, in breadth-first sorted order. `truncated` shall be true exactly when a bound stopped the crawl. Two crawls of the same site shall give byte-identical page maps (oracle: metamorphic).
- AC-SPEC-37-04: When a fixture page holds a filled text field, a paragraph, a 200-character button name, a declared secret's value and an email address, the page map shall hold the field's role and name but not its value, no paragraph text, the name cut to 80 characters, and neither the secret nor the email. Nor shall the planner request body (oracle: specified; seeded canaries).
- AC-SPEC-37-05: When the planner is called, the request shall contain only the criteria (if any), grammar version, origins, targets and page map. Cookies, storage, screenshots, query strings, typed values and artefact paths shall be absent (oracle: specified; extends AC-SPEC-28-11).
- AC-SPEC-37-06: When the planner returns non-text, script-bearing or over-long output, no draft shall be written and the command shall report `plan-rejected` (oracle: specified; reuses AC-SPEC-28-12).
- AC-SPEC-37-07: When a draft is written, it shall pass through `admitDraft` with source `explore-draft`, basis `core-recorded` and the page map's sha256 as reference. It shall be unapproved, and nothing shall run it. The same plan admitted under any other source shall get the same policy decision and approval requirement (oracle: specified; extends AC-SPEC-28-03 and 08).
- AC-SPEC-37-08: When a fixture draft has one locator missing from its page and one matching two elements, the result shall carry `locator-not-on-page` and `locator-ambiguous` at those lines. A locator after a click on the same page shall not be checked (oracle: specified).
- AC-SPEC-37-09: When `--after` names a plan with no approval for its hash, the command shall stop with `after-plan-unapproved` before any browser starts. When it names an approved login plan, that plan shall pass the policy gate first, and the values it types shall appear in no page map, request, draft or event (oracle: specified; seeded canary).
- AC-SPEC-37-10: When the command runs on a fixture site with a recorded planner response, the draft, page map and `--json` output shall be byte-identical across runs, and the draft shall start with the fixed notice (oracle: regression; golden transcript).
- AC-SPEC-37-11: When no isolated runner is available, the command shall stop with `explore-runner-unavailable` unless `--host` is given. With `--host`, the page map shall say `guaranteeLevel: 'host'` and the output `egressEnforced: false` (oracle: specified).
- AC-SPEC-37-12: When a fixture page tells the planner to visit an undeclared origin or add a page script, and the recorded planner response obeys it, the draft's offending lines shall be refused by the parser or the policy gate, and no driver, network or runner call shall follow from the draft (oracle: specified; hostile-plan proof).
- AC-SPEC-37-13: When each planner wire format is called against a local fake server, the request shall match its recorded golden body. The API key shall appear in no output, log, error or event. A `local` endpoint off loopback shall be refused with `planner-endpoint-not-loopback`, and a failed call shall give `planner-call-failed` without the response body (oracle: specified).

## Dependencies

- SPEC-28 (`draft`, `admitDraft`, `DraftRequest`, `PlannerEndpoint`), SPEC-01 (`parseAiText`, `parsePlan`), SPEC-02 (approval of the `--after` plan; proposal runs to try a draft), SPEC-03 (policy gate), SPEC-04 (secrets and redaction), SPEC-06 (CDP driver, accessibility tree), SPEC-07 (isolated runner and egress), SPEC-27 (error codes, events).
- SPEC-09 (M3): its PII pass replaces this spec's pattern redaction, and its logging manifest lists the planner egress. Until then the egress is listed here and in the `--json` output.
- Founder decision of 2026-10-29: drafting moves earlier, and a live-page route is added (`docs/decisions/drafting-earlier.md`).
- Research background: the industry pattern of AI once, then deterministic replay, and exploration as an assisted level (`01`, the automation-levels table); live-agent testing is cheap and non-deterministic by design (`02`, competitors; `08`, risk 2).

## Milestone

M2, after SPEC-28's `draft` (route c), which comes first with the planner adapters.

## Satisfies

The founder's request of 2026-10-29. It extends the requirements SPEC-28 satisfies; the research gives it no requirement of its own.
