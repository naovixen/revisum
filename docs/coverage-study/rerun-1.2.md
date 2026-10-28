# Coverage study: re-run on plan language 1.2

## In short

- Whole-test share, as `node tools/coverage-study.ts` reports it:
  - **original sample: 50 of 100 (50.0%)**, up from 38;
  - **fresh sample: 18 of 50 (36.0%)**;
  - **both: 68 of 150 (45.3%)**.
- The kill criterion is 70% of sampled intents expressible without an escape hatch. **It is not met on either sample.** The fresh sample, drawn after the language was designed, is the better measure of fit: 36%.
- 22 originals changed verdict: 17 up, 5 down. The design projection for this sample was 72 with assumptions and 60 firm. The measured 50 is below both.
- Of the 68 expressible intents, 33 rest on something not yet proven:
  - 25 need SPEC-06 driver parts;
  - 7 need SPEC-07's service caller;
  - 7 rest on a plausible HTTP endpoint;
  - 17 rest on a stated assumption about the app.
- Counting only intents with no stated assumption: 42 of 100, 9 of 50, and 51 of 150 (34.0%).

## Method

- **Sources.**
  - The original 100 were re-judged from the files the first run read and from `step-count.md`'s per-test breakdown. Helpers and page objects were read where a verdict turned on them.
  - The fresh 50 were read at the same pinned commits as raw GitHub files and directory listings.
- **Fresh sample.** Five intents per suite, drawn before any language change:
  - the next five spec files alphabetically after those already used, first test of each, skipped tests included;
  - MediaWiki has seven files and the Real World App seven. There the rule continues with the next unused test of each file from the top. That is MediaWiki's `user.js` second test, then the third tests of `category.js`, `page.js`, `pageadmin.js` and `user.js`; and the Real World App's four remaining second tests, then `auth.spec.ts`'s third.
- **Rules.** As in `report.md`'s "Sample" section. Every step counts, hooks included, and a weaker check never stands in for the original.
  - Declared calls count only where the suite already calls that HTTP endpoint. The cited files are Supabase `e2e/studio/utils/db/client.ts` (`POST /pg/query`), Rocket.Chat `apps/meteor/tests/e2e/utils/test.ts` (REST `/api/v1`), and Grafana `frontend-sandbox-app.spec.ts` and the `@grafana/plugin-e2e` `createDataSource` fixture. The Real World App's `cypress.config.ts` (`/testData`) was checked too.
  - Standing preconditions still count, as in the first run.
- **Projects.** Each suite has its own project with only what its tests show:
  - origins and secret names;
  - services, calls, stubs, observed requests and storage entries;
  - test-id attributes: `data-test-id` for Saleor, `data-test` for the Real World App, `id` where a test finds an element by id, and `data-plugin-sandbox` for Grafana;
  - limits.
  - Existing Saleor and Real World App plans were re-pointed at their suite's attribute, which they had silently missed.
- **Two facts about 1.2, checked in code, that decided many verdicts.** Locators match exactly: role names, labels and text are compared whole, and test ids by whole value. A `press` step focuses its element before the key.
- **The parser as a check.** One plan (Grafana migrate-to-cloud) was refused: its test ids exceed the 64-character limit. It is recorded as not expressible.

## Findings

### Shares by suite

| Suite | Original | Fresh |
|---|---:|---:|
| Cal.com | 4/10 | 1/5 |
| Grafana | 6/10 | 2/5 |
| Supabase Studio | 6/10 | 3/5 |
| Rocket.Chat | 4/10 | 2/5 |
| Saleor Dashboard | 9/10 | 4/5 |
| WordPress Gutenberg | 1/10 | 0/5 |
| Mattermost | 2/10 | 0/5 |
| MediaWiki | 10/10 | 5/5 |
| OpenProject | 2/10 | 0/5 |
| Real World App | 6/10 | 1/5 |
| **All** | **50/100** | **18/50** |

### Originals that changed verdict

**Up (17):**

- Grafana:
  - both sandbox tests: declared calls, plus a declared `data-plugin-sandbox` attribute;
  - graph auto-migrate: a position;
  - inspect drawer: a selected state, assuming `aria-selected`.
- Supabase:
  - array column: SQL through `/pg/query`, and a remembered table id;
  - type generation: a download;
  - edge functions: stubs and a link target.
- Rocket.Chat:
  - forget-session: a declared setting call and a second tab;
  - token-expiry: declared storage entries and a storage-state secret.
- Saleor: attribute, channel and customer, through unique values.
- Mattermost:
  - channel autocomplete with spaces: an id attribute and a position, assumed;
  - long post: multi-line text, an id attribute and a position.
- MediaWiki: both "create account" tests, through unique values.
- Real World App: transaction request, a selected state.

**Down (5).** All five are among the 10 that `step-count.md` found over-generous:

- Grafana filter-type: the earlier plan covered 20 of 34 steps, and a click at the page corner, label-parent checkboxes and scoped markers remain.
- Supabase users list: "Email" is checked inside the new row, which has no exact name or known position.
- Rocket.Chat profile: the avatar is clicked as an element inside the last non-sequential message.
- Gutenberg allowed patterns: an exact option list. The options have different names, so no single locator counts them.
- Real World App new bank account: items are counted by test ids that end in record ids.

**The other 5 over-generous ones are now genuinely expressible.** Their plans were fixed:

- Saleor app smoke and install-from-manifest: positions added. The install plan had also stopped before its fill, save and banner.
- Saleor category and collection: a URL path prefix, as strong as the source's unanchored pattern.
- Real World App form errors: "no helper text" by element id. The earlier plan had also stopped at the routing number.

**Projected up, but not found expressible (17 of the design's 34):**

| Why | Intents |
|---|---|
| Positions need one locator that matches every item. List items and options have no shared name, and record-id test ids cannot be matched by prefix | Grafana bookmarks, Real World App first transaction |
| `press` focuses its own element, so focus-moving key runs need every intermediate region named | Gutenberg region navigation (2) |
| A remembered value cannot be cut or joined with other text | Saleor gift card (last four characters), Mattermost MM-T132 (generated channel name in an id and URL) |
| Weaker than the source | Supabase clipboard lines (the source checks them only within the table's block), Cal.com SSR (title and og:image are containment checks), Cal.com duplicate calls (a sum of two request counts) |
| Reads outside the language | Supabase assistant (a streamed text body), Rocket.Chat TOTP (method called and read by script; the stub echoes a request id), Gutenberg PHP fatal (a cookie and the editor's data store), Mattermost at-mention loading (app state store) |
| Locator not reachable | Supabase API access (a switch found only by filtering), Real World App payment (an unnamed logo link), Mattermost MM-T2199 (the post checked through its id) |
| Database seeding | OpenProject export |

### Why fresh intents are not expressible (32 of 50, primary reason)

| Reason | Count | Examples |
|---|---:|---|
| Database seeding or database checks (factories, Prisma) | 8 | all five OpenProject tests, three Cal.com tests |
| CSS class, computed style or CSS-only locator | 7 | Cal.com dark-mode class, Gutenberg dark canvas and custom CSS, Mattermost muted class, Real World App amount colours |
| Editor data store or other page script | 3 | three Gutenberg tests |
| Element with no name, or found only inside a container with no known position | 3 | Rocket.Chat rooms table, Supabase dialog combobox, Grafana collapse button |
| Elements found by record ids: test-id prefixes or ids read from the page | 3 | Real World App notifications and likes, Mattermost post menus |
| Others, one each | 8 | text joined from a run value, test id over 64 characters, performance metrics, whole-JSON equality, a second user's session, branching on page values, weekday in another locale, a cookie |

### How much rests on parts not yet built or not yet checked

| Reliance | Original (of 50) | Fresh (of 18) |
|---|---:|---:|
| Needs SPEC-06 driver parts | 18 | 7 |
| Needs SPEC-07's service caller | 5 | 2 |
| Plausible HTTP endpoint | 5 | 2 |
| Stated assumption about the app (a name, an `aria-selected`, a layout) | 8 | 9 |
| Any of these | 20 | 13 |

- Without the driver parts, which are not built yet, none of the 25 runs today, even though each one parses.
- The seven plausible endpoints are all calls the suites already make. The auth differs in some: Grafana's plans use basic auth where the suite's `page.request` uses the session cookie.

## Risks

- **One judge, and many locator names written from page-object names.** The fresh Saleor and Rocket.Chat plans name controls that were not read from the apps. A wrong name breaks a run, not the verdict's logic, but 17 verdicts carry an explicit assumption.
- **The first run's 28 strict plans were not re-audited for exact matching.** Some check text that the source matched as a substring, for example MediaWiki's "has been undeleted". A full audit against exact locators could move a few verdicts down.
- **Borderline calls went strict.** A looser reading would add 3: Supabase's empty-list check ("present, no first item"), Cal.com's duplicate-call sum (one count per endpoint) and Mattermost's composed DM intro text (two partial checks). That would make the fresh sample 20 of 50 (40%) and the original 51 of 100.
- **The fresh sample is small:** 5 per suite, first test of each file, not random. At 50 intents, 36% has a wide margin of roughly ±13 points.
- **Several gaps point to small language changes.** Examples:
  - a key press at the current focus;
  - text built from a run value (prefix, slice);
  - a count or position over items with a shared role but different names;
  - longer test ids;
  - a JSON-equality backend check.
  
  Designing them now would overfit to this sample again. Any language change needs another fresh sample.
- **Database seeding is the largest single cause in both samples.** OpenProject and Cal.com seed through factories and Prisma. Only a test-build HTTP seeding route, which those teams would have to add, closes it.
