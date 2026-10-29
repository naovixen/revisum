# Coverage study: re-run on plan language 1.3 with unsafe features

## In short

- Shares, as `node tools/coverage-study.ts` reports them:

| Sample | Closed language (1.2) | 1.3 with unsafe features |
|---|---:|---:|
| Original | 50/100 (50.0%) | **56/100 (56.0%)** |
| Fresh | 18/50 (36.0%) | **22/50 (44.0%)** |
| Both | 68/150 (45.3%) | **78/150 (52.0%)** |

- Judged strictly, unsafe features add **10 intents**: 6 original and 4 fresh. The design projection was 124 of 150 (86 and 38). The measured 78 is 46 below it.
- The kill criterion counts the closed share only, so **it is still not met**: 36% on the fresh sample. With unsafe features the fresh share is still under 70%.
- The 10 rest on CSS locators (9), DOM checks (4) and one named page script. XPath, inline scripts and database commands unlock nothing under the strict rules.
- All 10 need SPEC-36 driver parts, which are not built. 4 also rest on a stated assumption about the app.
- Of the 72 still out, 42 are in Playwright suites. Evidence mode would run them whole, apart from caveats (Findings). The 30 in Cypress and Capybara suites stay out of reach.

## Method

- **Rules.** As in `rerun-1.2.md`: every step counts, setup and teardown included, and declared calls only for endpoints the suite evidences. The founder's answer 5 (`docs/decisions/language-fit-pivot.md`) adds three rules, without the projection's generous assumptions:
  - A **CSS or XPath locator** counts only for the selector the test itself uses. Examples: Cypress `getBySelLike` (`[data-test*=…]`), a Playwright `page.locator('…')`, or a page object's XPath. It never replaces a role, label or text lookup. It never stands in for a record id read from the page (no id-prefix stand-ins), and never for a key press at the current focus (no `:focus` stand-ins).
  - A **declared page script** counts only for the same script or storage logic the test runs in the page.
  - A **database command** counts only where the suite's own setup runs that query or command, and it can be declared as a fixed argument vector.
- **Closed verdicts unchanged.** No 1.2 plan was edited. All 68 still parse under their suite's project now that the project enables unsafe features. The closed share is unchanged.
- **Re-judged.** All 82 intents that were out on 1.2 were re-read at the pinned commits, as raw GitHub files. That covered the helpers and page objects a verdict turned on: the Real World App's commands and `cypress.config.ts`, Rocket.Chat's page objects and fragments, Gutenberg's `insertBlock` and `publishPost`, Cal.com's `submitAndWaitForResponse`, and Grafana's selectors. The Real World App's seed balances come from `data/database-seed.json`.
- **Projects.** Each suite enables only the features its new plans use:
  - Cal.com: CSS and DOM checks, plus an observed request and a storage entry;
  - Grafana: CSS and DOM checks, plus a storage entry;
  - Gutenberg: CSS, DOM checks and one named script, `insertLegacyGradientGroup`. It is the suite's `editor.insertBlock` with that test's block, because script arguments can't be objects;
  - Real World App: CSS and DOM checks, one allowed unnamed selector (`[data-test="app-name-logo"] a`), and a declared `GET /testData/users` call.
  
  No other suite enables any feature.
- **The parser as a check.** All 78 expressible plans parse under their suite's project. The tool overturned none.

## Findings

### Newly expressible (10)

| Intent | Features | What made it | Stated assumption |
|---|---|---|---|
| Cal.com Date Overrides | CSS | The source's own `[data-testid="day"][data-disabled="false"]` and `… > li` count | The standing account starts with no overrides |
| Grafana bar gauge | CSS, DOM | The panel selector plus a computed colour | none |
| Grafana bookmarks | CSS | The source's `ul[aria-label=…]`, `li` first and last, and the expand button | The test starts on the home page; "Bookmark Administration" is unique |
| Real World App new bank account | CSS | `[data-test*=bankaccount-list-item]` count and second item | none |
| Real World App payment | CSS, DOM | `getBySelLike` selectors, the logo link, `Mui-selected`, and the contact's balance by declared call | Plausible endpoint; figures from the seed |
| Real World App tabs hidden | CSS | The first `[data-test*=transaction-item]` | none |
| Cal.com dark theme (fresh) | CSS, DOM | The `dark` class on `html`, plus a storage entry | "Dashboard theme" is exact, unique text |
| Gutenberg legacy gradient (fresh) | page script | `insertBlock` as a declared script | none |
| Gutenberg dark canvas (fresh) | CSS, DOM | The canvas `body` class | none |
| Real World App likes (fresh) | CSS | `getBySelLike` item, like button and count | none |

**Unlocks per feature** (an intent may use several):

| Feature | Original | Fresh | Both | The only feature it uses |
|---|---:|---:|---:|---:|
| `css-locator` | 6 | 3 | 9 | 5 |
| `dom-checks` | 2 | 2 | 4 | 0 |
| `page-script` | 0 | 1 | 1 | 1 |
| `xpath-locator`, `inline-page-script`, `database-command` | 0 | 0 | 0 | 0 |

**Reliance.** All 10 need SPEC-36 driver parts: CSS and XPath resolution, DOM reads and page scripts, all in M2. One also needs SPEC-07's service caller and a plausible endpoint. Four carry a stated assumption. Six rest on nothing but unbuilt driver parts.

### Why the projection's 56 became 10

- **Database commands: 19 projected, 0 measured.** Cal.com seeds through Prisma in test code and OpenProject through factories. Rocket.Chat writes MongoDB documents whose keys are made per run (`dept_${Date.now()}`), and a declared command takes a value only as a whole argument. None of the suites runs a command or a query that a fixed argument vector reproduces.
- **Generous locator categories dropped.** Record-id prefixes, `:focus`, and CSS written in place of a role lookup are all out. Examples: Mattermost's `#postMessageText_${postId}`, Gutenberg's region presses, Rocket.Chat's unnamed list items and comboboxes.
- **New blockers found on re-reading:**
  - Gutenberg `allowedBlocks`: the check compares with an empty list, and checks read one scalar field.
  - Gutenberg custom CSS: the post id comes from the URL in test code.
  - Grafana migrate-to-cloud: `check()` is idempotent, but a plan click toggles.
  - Rocket.Chat profile: the room is opened through an unnamed search combobox.
  - Real World App feed: the record is looked up from an id cut from an attribute.

### Why the remaining 72 fail (primary reason)

| Reason | Original | Fresh | Both |
|---|---:|---:|---:|
| Database seeding with no fixed command in the suite (factories, Prisma, per-run MongoDB keys) | 15 | 8 | 23 |
| A role or text locator scoped inside another element, or a role with no name, where the source uses no CSS (plan locators nest only under CSS or XPath) | 4 | 4 | 8 |
| Text built from a run value (joined or cut) | 4 | 3 | 7 |
| A comparison the language lacks (sum of counts, containment of title or attribute, empty list, whole JSON, less or greater than a count, lines within a block) | 5 | 2 | 7 |
| Typing or pressing at the caret or current focus | 5 | 1 | 6 |
| Reads or actions outside the language (streamed body, server files, performance metrics, cookies, URL read by test code) | 3 | 3 | 6 |
| A record id read from the page and joined into a selector | 4 | 1 | 5 |
| Branching | 1 | 1 | 2 |
| Another user, or a login token made at run time | 0 | 2 | 2 |
| Others, one each (page-corner click, mid-test viewport, weekday in another locale, a stub echoing a request id, a random upload name, an idempotent `check()`) | 3 | 3 | 6 |
| **Total** | **44** | **28** | **72** |

### Evidence mode on the remainder

- 42 of the 72 are in Playwright suites:
  - Cal.com 8;
  - Grafana 5;
  - Supabase Studio 6;
  - Rocket.Chat 9;
  - Saleor 2;
  - Gutenberg 12.
  
  Evidence mode runs each suite whole, as its authors wrote it, at the `host` level.
- Caveats:
  - Rocket.Chat's profile test is skipped in the suite, so it would be reported skipped.
  - 12 connect straight to a database from test code: all 8 Cal.com tests through the Prisma user fixture, and 4 Rocket.Chat tests through MongoDB, which are also Enterprise-only. SPEC-35's proxy blocks raw TCP to undeclared hosts, so these need a database allowance that SPEC-35 doesn't yet define.
  - Supabase's assistant test needs a live AI key.
  - Without these, 28 would run with only HTTP egress to the app.
- The other 30 are Mattermost (13) and the Real World App (4), both Cypress, and OpenProject (13), Capybara. Evidence mode supports Playwright only (founder's answer 4).

## Risks

- **One judge, as before.** Every new plan was written from short quotes of the source, not run. Their unsafe selectors are copied from the source, but the closed parts (sign-in, labels) follow the 1.2 plans, so a wrong name breaks a run, not the verdict's logic.
- **The strict rules decide the number.** A projection-style reading would add about:
  - 19 database intents, if teams wrote seed commands;
  - 10 id-prefix and `:focus` intents;
  - 8 role-to-CSS substitutions.
  
  Those are writable but not faithful. The founder asked for the faithful count.
- **Closed verdicts weren't re-audited.** Gutenberg "insert a block pattern" (1.1 plan) checks the inserted block as visible, where the source reads the editor's block list by script. That is weaker by the 1.2 rules, and a 1.3 page script could now make it faithful. Left as it is, as the brief required.
- **Unused declarations kept.** The Grafana project's nine migrate-to-cloud stubs, written for the refused 1.2 plan, differ from the source at the pinned commit: result `refId`s, missing `parentName`, and the finished snapshot's times and status counts. No expressible plan uses them.
- **Language gaps the re-run exposes** are for SPEC-36's follow-up, not this study:
  - semantic locators can't take a container;
  - XPath can't hold `@`, so it has no attribute predicates;
  - there is no idempotent check or uncheck step;
  - script arguments can't be objects.
  
  Designing for them now would overfit to this sample, and any change needs another fresh sample.
- **Small samples.** At 50 fresh intents, 44% has a margin of roughly ±14 points.
