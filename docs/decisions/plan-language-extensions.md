# Plan language extensions: closing the coverage-study gaps

## In short

- The coverage study found 38 of 100 test intents expressible in plan v1.1, against the 70% kill threshold (`docs/coverage-study/report.md`). The founder asked (2026-10-28) for specs that fill every gap they can while keeping the engine's containment.
- Four draft specs make up plan language 1.2. SPEC-30 owns the version bump, the schema and the changelog.
  - **SPEC-30:** run values (unique, dated, remembered), positions, declared test-id attributes, key chords, multi-line text, a URL prefix and path templates.
  - **SPEC-31:** accessibility states, link targets, head metadata with a server-rendered view, downloads and a second tab.
  - **SPEC-32:** declared HTTP calls for test data, cleanup and backend checks.
  - **SPEC-33:** declared network stubs, request checks and web storage.
- **Projection, not a measurement:**
  - 72 of 100 (72%) if every assumption below holds;
  - 60 of 100 (60%) counting only intents with no assumption;
  - 82 of 100 if teams also add an HTTP seeding route for data that is now seeded straight into the database.
- The features were designed against this same sample, so a fresh sample will likely score lower. AC-SPEC-30-18 makes the re-run report a fresh sample of at least 50 separately.
- Containment holds:
  - no script, CSS selector, XPath, regular expression or sleep enters a plan;
  - every new power is declared in the trusted project file and approved by the founder's push;
  - plans refer to declarations only by name, with typed arguments.

## Decisions

| Decision | Why | Confidence |
|---|---|---|
| One version bump, 1.2, owned by SPEC-30. SPEC-31 to 33 add to its "unreleased" changelog entry, which is dated when the last parser part lands | One bump keeps a single published version. `1.1` plans parse unchanged, so nothing needs migrating | high |
| Powerful features are declared in `project.json` under `calls`, `stubs`, `observedRequests` and `storageEntries`, and plans name them | The trusted file is read only from the protected branch, and edits in the change under test are ignored (SPEC-02). An agent cannot grant itself a power | high |
| Text parameters fill only whole JSON values, path segments or query values. Interpolation inside strings is limited to types that cannot hold separators | SQL-over-HTTP and path templates become injection-safe by construction, and AC-SPEC-32-03 checks it with generated inputs | high |
| Calls go through `runner` behind a `ServiceCaller` port in `contracts`. `engine` only builds requests, as a pure function | `engine` stays free of I/O and of new dependencies. The later `http/v1` pack reuses the port (SPEC-23 compatibility in SPEC-32) | high |
| Stubs live in the driver (CDP `Fetch`), not the egress proxy. They answer only fetch and XHR, with data media types and `nosniff` | HTTPS bodies can't be answered at the proxy without intercepting TLS. Limiting types means a stub can never serve code | med |
| Unique values come from the hash of seed, clock start and name. Dates are relative to the frozen clock, in the target's time zone | Both inputs are already in the manifest (SPEC-08), so values replay exactly and differ between runs. No manifest field is added | high |
| Remembered values (from the page or a response) are untrusted text: checked at read time, never put into an origin, a header or a declaration name, and never recorded, only their name and hash | Page content is attacker-controlled. Path templates percent-encode them and keep the base URL's origin | high |
| Plans with no approval may not make write calls, start stubs or write storage unless the declaration allows it (`side-effect-in-proposal`) | A draft plan from an agent should not change backend data before a person sees it | med |
| Downloads and a plan-opened tab are pulled forward from SPEC-06's phase-2 non-goal. Popups the page opens stay `unsupported-step` | Only the scoped, plan-requested forms are needed, and AC-SPEC-06-05 still holds for everything else | med |

## Findings

### 1. Gaps, and what closes them

A test can have several gaps, and it becomes expressible only when all of them close. The counts are from the study's 62 inexpressible tests.

| Gap | Count | Closed by | Closed in the sample |
|---|---|---|---|
| API or database seeding | 24 | SPEC-32 (HTTP only) | 9 now; 10 more only with an HTTP seeding route; 5 stay out for other reasons |
| Network stubs or request checks | 6 | SPEC-33 | 6 |
| Page scripts, mostly storage | 5 | SPEC-33 storage | 2: Grafana bookmarks, Rocket.Chat login. The editor data store (2) and the autosave trigger (1) stay out |
| Values unique to each run | 5 | SPEC-30 | 5 |
| CSS class or selected state | 4 | SPEC-31 states | 2: tabs exposing `aria-selected`. Mattermost's highlight class and Grafana's text colour stay out |
| Positional locators | 4 | SPEC-30 | 3: Mattermost "Jump" also needs a post id held in an attribute |
| Backend state outside the UI | 3 | SPEC-32 `expectBackend` | 2: image frame counts stay out |
| Downloads | 2 | SPEC-31 | 2 |
| Key chords | 2 | SPEC-30 | 2 |
| Values read and reused | 2 | SPEC-30 `remember` | 1: Grafana's advisor test also branches |
| Multi-line text | 1 | SPEC-30 | 1 |
| Second tab | 1 | SPEC-31 | 1 |
| Layout geometry | 1 | none | 0 (non-goal) |
| Raw server HTML, head meta tags | 1 | SPEC-31 | 1 |
| Date computed from today | 1 | SPEC-30 | 0: Cal.com "Date Overrides" also picks the first *enabled* day by attribute |

### 2. Projection, intent by intent

"Assumed" marks an intent that becomes expressible only if a fact about the app holds that this study did not check.

**SPEC-30 alone (11):**

- Saleor:
  - SALEOR_124 attribute;
  - SALEOR_97 channel;
  - SALEOR_199 customer;
  - SALEOR_105 gift card (`remember`).
- MediaWiki: "should be able to create account" in `temporaryuseraccount.js` and in `user.js`.
- Gutenberg:
  - "navigates forward and back again" (assumed: the block can be inserted through the UI instead of by script);
  - "navigating through the Editor regions four times…".
- Mattermost: MM-T104 long posts.
- Grafana: "Graph panel is auto-migrated".
- Real World App: "transactions navigation tabs are hidden…" (position and URL prefix).

**SPEC-31 (5), plus 1 that also needs SPEC-32:**

- Grafana: "Tests various Inspect Drawer scenarios" (assumed: the active tab sets `aria-selected`).
- Real World App: "…submits a transaction request" (assumed: the selected tab sets `aria-selected`).
- Supabase: "generates types for exposed schemas only" (download).
- OpenProject: "exports the visible projects" (download).
- Cal.com: "check SSR and OG - User Event Type" (assumed: the checked `href`s are on links or the canonical tag).
- Rocket.Chat: "Login using credentials and reload to stay logged in" (second tab, and a setting changed by a declared call).

**SPEC-32 (9):**

- Grafana: "Loads the app page with the sandbox div wrapper" and "Should render a sandbox wrapper around the datasource config editor" (assumed: the wrapper's data attribute carries a stable value, matched as a declared test-id attribute).
- Supabase: "API access is default on for a new table" and "editing an array column preserves its type…" (assumed: SQL runs through Studio's own HTTP query endpoint).
- Mattermost:
  - "should load a user who joins the channel";
  - MM-T132 (assumed: the suggestion list's `id` is stable, matched as a declared `id` attribute);
  - MM-T2199;
  - MM-T1662_1.
- Real World App: "…submits a transaction payment" (assumed: the app's test-data HTTP routes expose the balance).

**SPEC-33 (8):**

- Cal.com: "should detect when schedule endpoints are called multiple times… beginning of month" (request count and plan clock).
- Supabase:
  - "Can send a message to the assistant…" (assumed: a configured AI key counts as a standing precondition; the run is not replay-stable);
  - "links an sb-error-code response to its documentation".
- Rocket.Chat:
  - "opens the TOTP modal…" (stub sequence);
  - "should remove private_key and public_key from localStorage when token expires".
- Gutenberg: "PHP fatal error" (autosave stub).
- Real World App: "User A likes a transaction of User B…" (assumed: the badge equals the response's array length).
- Grafana: "should pin the selected menu item…" (storage and position).

**Conditional, only with an HTTP seeding route the team adds (10).** These tests seed straight into the database today:

- Cal.com: "should successfully confirm a booking via GET /api/verify-booking-token" and "should auto-fill untouched phone fields…".
- Rocket.Chat: the three attribute-based access control tests (attributes edit, panel, creation).
- OpenProject:
  - "renders only required project attribute";
  - "destroys the project";
  - "hides the field whose functionality is presented otherwise";
  - "allows favoriting and unfavoriting projects";
  - "allows adding and removing modules" (also assumed: the tab found by XPath has a role and name).

**Stays out (18):**

| Suite | Test | Why it stays out |
|---|---|---|
| Cal.com | Date Overrides | Picks the first enabled day by attribute (a filtered position) |
| Cal.com | Per day | Loops over computed dates |
| Grafana | should detect an issue and fix it | Branches on whether a report exists |
| Grafana | Bar Gauge Panel | Computed text colour |
| Supabase | actions works as expected | Clipboard read |
| Rocket.Chat | classification banner… | Background colour |
| Gutenberg | should insert inline image | Unlabelled hidden input; content read from the editor's data store |
| Gutenberg | deselecting all blocks… `allowedBlocks` | Editor data store |
| Gutenberg | keeps the animation in every sub-size… | Frame counts of server-made images |
| Gutenberg | User Mention… | Editor data store |
| Gutenberg | should save to sessionStorage | Autosave triggered by script; needs the virtual clock advanced |
| Mattermost | should be always highlighted | CSS class |
| Mattermost | MM-T210 overlap with RHS | Layout geometry and a viewport change |
| Mattermost | MM-T1630 "Jump" | Post ids held in attributes |
| Mattermost | MM-14490 menu dividers | Dividers counted by CSS class |
| Mattermost | MM-T179 permalink | Clipboard read |
| OpenProject | shows help text modal… | Bold text checked by CSS element |
| OpenProject | can deselect the current project… | Items counted by CSS selector |

**Arithmetic:**

| Landed | Firm | With assumptions | Running total, with assumptions |
|---|---|---|---|
| Today | 38 | 38 | 38 |
| SPEC-30 | +10 | +11 | 49 |
| SPEC-31 | +2 | +5 | 54 |
| SPEC-32, plus the Rocket.Chat test needing 31 and 32 | +1 +3 | +1 +9 | 64 |
| SPEC-33 | +6 | +8 | 72 |
| **Total** | **60** | **72** | |

- Firm: 38 + 22 = 60%. With assumptions: 38 + 34 = 72%. With the 10 conditional intents as well: 82%.
- Of the 62 inexpressible tests, 18 stay out whatever is built here.
- SPEC-34 would add 2, both assumed and both also needing SPEC-32's seeding: Supabase "actions works as expected" (clipboard lines checked anywhere in the copied SQL, not only within the table's block) and Mattermost MM-T179 (the copied permalink remembered and posted). That gives 60 firm and 74 with assumptions. `advanceClock` closes none in the sample: Gutenberg "should save to sessionStorage" triggers autosave by script, and its storage key holds the post id.

### 3. What stays out, and why

| Left out | Reason |
|---|---|
| Page scripts and application data stores | Code in the page breaks containment and ties tests to private internals |
| CSS classes, computed styles, colours, layout geometry | They need selectors or pixels. Visual baselines (SPEC-12) cover appearance |
| Branching and loops | A straight-line plan's meaning is fixed when it is approved |
| Direct database connections and shell commands | New dependencies on the trust path; ambient authority outside egress control; nothing to replay. The alternative is an HTTP seeding route, below |
| Attribute reads into values | They reopen CSS-style probing. Declared test-id attributes match by equality only |
| Clipboard reads, viewport changes, popups the page opens | Platform- and permission-dependent, or fixed per target. Open questions below |
| Plan-written HTTP requests | That is the `http/v1` pack (SPEC-23, phase 2b) |

**HTTP seeding route.** A team whose tests seed straight into the database adds a small route to its test build only, for example `POST /test-data/projects`, taking JSON. It declares that route in `calls` with `effect: 'write'`, on a non-production service, with its token as a secret. Everything then flows through SPEC-32's checks.

### 4. Security argument

1. **The language stays closed.** Every new field is a closed union decoded by engine's parser. No free text reaches an interpreter: no selector, script, regular expression or plan-written URL, method, header or body. SQL and request shapes exist only in declarations a person approved.
2. **Authority comes from the approved project.** Calls, stubs, observed requests and storage entries come only from `project.json` on the protected branch (SPEC-02). An agent's edit in its own change is ignored and raised as `changed-with-code`. Plans with no approval cannot cause side effects unless a declaration allows it.
3. **Reach is bounded.**
   - Calls go only to declared services, through the egress proxy and its address check.
   - Stubs answer only fetch and XHR requests on allowed origins, with data media types.
   - Storage writes touch only declared keys on the current origin.
   - Downloads stay in the container under generated names.
4. **Credentials stay by name.** Header secrets resolve through `SecretStore` inside `runner` only. Header values are never recorded, and the leak scan covers call, response, storage and download evidence.
5. **Page data stays untrusted.** Remembered values and response fields are checked at read time. They are encoded wherever they are used, and are never an origin, header or declaration name. Values are logged only through the redactor.
6. **Runs stay deterministic.** Values come from the seed and the frozen clock. Stub responses are fixed and recorded. Replay feeds recorded call responses instead of repeating calls, and calls are listed in `nonHermeticInputs`.
7. **Hostile plans are tested.** Every new step has hostile-plan criteria: rejected with a code and path, no value echoed, zero driver or network calls.

### 5. Error codes added

| Spec | Plan codes | Other codes |
|---|---|---|
| SPEC-30 | `undefined_value`, `position_not_allowed` | `StepErrorCode`: `value-empty`, `value-unsafe`, `value-too-long` |
| SPEC-31 | `misplaced_step` | driver: `no-download`, `download-too-large`; step: `state-not-exposed`, `download-not-text` |
| SPEC-32 | `unsafe_interpolation`, `header_not_allowed` | `ServiceCallErrorCode`: `response-not-json`, `response-too-large`, `field-missing`, `service-unreachable`, `call-timeout`, `unexpected-status`, `egress-blocked`, `parameter-invalid`, `cleanup-failed`; policy: `side-effect-in-proposal` |
| SPEC-33 | none | driver: `storage-origin-mismatch`; step: `request-not-seen` |

### 6. Milestones

| Spec | M1, after SPEC-04 | Later |
|---|---|---|
| SPEC-30 | Grammar, parser, schema, changelog, values, dates, clock, coverage input | Driver parts with SPEC-06 (M2) |
| SPEC-31 | Grammar, parser | States, metadata and server view with SPEC-06 (M2); downloads and tab after AC-SPEC-06-02 and SPEC-07; kept downloads after SPEC-09 (M3) |
| SPEC-32 | Declarations, request building, policy, against a fake caller (needs SPEC-02 and 03) | `runner` caller with SPEC-07; replay with SPEC-08 (M2); body excerpts with SPEC-09 (M3) |
| SPEC-33 | Declarations, grammar, policy | CDP network and storage ports with SPEC-06, after SPEC-07 (M2) |

None of the driver parts is needed for the M2 alpha exit.

## Risks

- **Overfitting.** The features were chosen by reading these 100 intents. The 72% is an upper estimate for this sample. Only the fresh sample in AC-SPEC-30-18 measures fit.
- **The language-fit kill criterion falls due in week 3 (around 2026-11-23).** "Expressible" counts only plans that parse, so the parser parts of SPEC-30 to 33 must land, and the study must be re-run, before then. That means building them straight after SPEC-04 and before SPEC-28, which adds M1 work against the week-9.25 velocity criterion.
- **Is a declared call an escape hatch?** Research `05` calls script or CSS an escape hatch "declared in the project, never in the plan". Declared HTTP calls are neither, but a strict reader could count them. The founder should decide before the re-run.
- **A larger trusted file.** Approving `project.json` now means reviewing requests that can write data. A wrong declaration can damage the test environment. The bound is still non-production origins with disposable data (SPEC-03).
- **Stubs can hide real failures.** A check against a stub proves the UI, not the backend. AC-SPEC-33-14 labels every assertion that ran under a stub.
- **Brittleness.** Positions and request counts (quiet windows) are less stable than role locators. Key chords can trigger app shortcuts with no named control, which the policy guard cannot see.
- **Replay with calls and remembered values is decision replay.** The app's own behaviour stays non-hermetic, as `app-server` is today.
- **Unique values assume a fresh seed or clock start per run.** A CI job that pins both repeats them by design, as replay does.

## Founder's answers (2026-10-28)

1. Yes: SPEC-30 to 33's parser parts go ahead of SPEC-28 in M1, and the study is re-run before the kill date (`START.md`).
2. Yes: declared HTTP calls, stubs and storage count as expressible "without an escape hatch". An escape hatch means script or CSS in a plan.
3. Yes: a later spec adds `advanceClock` and clipboard checks (SPEC-34).
