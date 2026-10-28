# Coverage study: step count

## In short

- A second measure beside `report.md`. The official measure is still the whole-test count: **38 of 100 tests expressible (38.0%)**, unchanged.
- The same 100 tests hold **1,259 steps**. **873 are expressible in plan v1.1 (69.3%)**.
- Second view, not the official measure: with the 95 seeding steps set aside as setup, 873 of 1,164 steps are expressible (75.0%). With all API and database setup set aside, including the 87 setup steps judged standing preconditions, the share is 786 of 1,077 (72.9%).
- The biggest causes of unexpressible steps: seeding 95, positional locator 47, CSS or style 40, reused page value 29, backend check 26, page script 26.
- Judged step by step, 10 of the 38 tests marked expressible contain at least one step the plan cannot express. Only 28 tests have every step expressible.
- The kill criterion counts whole test intents, so the step share does not test it. Even so, the step share is below 70%. It falls to 62.4% if standing-precondition setup counts against the plan, and to 67.5% if visual snapshots do.

## Method

- **Sources.** Each of the 94 spec files was fetched raw at the commit pinned in its intent's `sourceUrl`. The files match, byte for byte, the copies the first run read. The sample, test names and verdicts are those in `intents.json`.
- **What counts as a step.** One step per user action, navigation, assertion or setup or teardown call. Setup and teardown calls include API or database seeding, a network stub or listener, a page script, a clock change, a generated value and a stored-session sign-in.
  - Chained calls count once per action or assertion, so `should('be.visible').click()` is two steps.
  - A helper or page-object call counts as the steps its name and arguments show: `expectPageToBeNotFound({ url })` is a navigation and a check. When the helper is defined in the same file, it is judged by its body. Otherwise it is not expanded, so a helper that makes many checks counts once.
  - A loop body counts once. A branch counts only for a desktop Chromium target.
  - Hook calls count once per test, and only those whose results the test uses. Setup for sibling tests in the same file, such as unused users or a team, is left out, as are set-up projects outside the file.
- **What does not count as a step.** Locator definitions, literal constants, logging, timeouts and scrolling. Waits for an element, a load state or a network response whose result is not asserted (the plan's checks wait for themselves). Run control such as skips. API-client or database-connection set-up. Page-object construction.
- **Judging.** The judging rule is the one in `report.md`'s "Sample" section, applied to each step:
  - Standing preconditions count as expressible: test accounts, settings and feature switches, plugins, themes and extensions, the demo app's fixed seed data, and their resets. These 87 steps are tallied apart, so the share can be read without them.
  - Records created through the API or database for one test count as seeding, and so does their teardown.
  - A UI substitute counts where `report.md` accepted one: MediaWiki API edits done through the edit form, sign-in by fill steps, plugin activation. A CSS-located button or input with a visible name is assumed reachable by role or label.
  - A generated value that a fixed value could replace (the record is deleted, or reruns do not collide) is expressible. A value that must be new on every run because the record stays is a unique value. A value read from the page or assigned by the server is a reused page value, or seeding when it comes from a seeded record. A value that depends on today's date is a computed date.
  - `first()`, `nth()`, `last()`, `eq()`, walking to a parent or child, or scoping that is needed because the same text appears elsewhere: positional locator.
  - A weaker check standing in for the original does not make the original step expressible. For example, per-option checks do not express an exact-list check.
  - A visual snapshot counts as a capture step (expressible), as `report.md` treats it.
- **Categories.** The list is closed, and each unexpressible step gets exactly one category. When both the check and the locator block a step, the check decides (a highlight class on a post found by its id is CSS or style).
  - seeding: API or database records for one test.
  - network stub or assertion: faked responses, or checks on requests and responses.
  - page script: code run in the page, local or session storage, the editor's data store, the clipboard.
  - unique value: a value that must be new on every run.
  - CSS or style: a CSS, XPath or attribute-only locator, or a computed-style or class check.
  - positional locator: as above.
  - selected or other state: an active or selected tab or mode.
  - download: a downloaded file's name or content.
  - key chord: a key with a modifier.
  - reused page value: a value read from the page or URL and used later.
  - computed date: a date computed at run time, or a faked clock.
  - multi-line text: text with line breaks.
  - second tab: a second page.
  - raw HTML or head: server HTML, head tags, element attribute values.
  - backend check: a database, API or file-system read outside the UI.
  - layout: a viewport change mid-test.
  - other: the rest. Of its 22 steps, 9 are negated or loose checks (not contains, not focused, a count that is not zero, either-or and normalised values). 6 branch on page state. 4 are URL patterns or prefixes with a server id. There is also one exact-list check, one unnamed element and one cookie.
- **Records.** The per-step working was kept in a scratch file outside the repo. The per-test table below is the record.

## Findings

### Totals

| Measure | Expressible | Of | Share |
|---|---:|---:|---:|
| Whole tests (official, `report.md`) | 38 | 100 | 38.0% |
| Whole tests with every step expressible (strict) | 28 | 100 | 28.0% |
| Steps | 873 | 1,259 | 69.3% |
| Steps, seeding set aside as setup (second view) | 873 | 1,164 | 75.0% |
| Steps, all API and database setup set aside (second view) | 786 | 1,077 | 72.9% |
| Steps, standing-precondition setup counted against | 786 | 1,259 | 62.4% |
| Steps, visual snapshots counted against | 851 | 1,259 | 67.5% |

Shares are rounded down. Tests have between 2 and 49 steps; the median is 9.

### Unexpressible steps by category

| Category | Steps | Share of unexpressible steps | Tests with at least one |
|---|---:|---:|---:|
| seeding | 95 | 24.6% | 28 |
| positional locator | 47 | 12.1% | 19 |
| CSS or style | 40 | 10.3% | 18 |
| reused page value | 29 | 7.5% | 9 |
| backend check | 26 | 6.7% | 11 |
| page script | 26 | 6.7% | 10 |
| network stub or assertion | 22 | 5.6% | 6 |
| other | 22 | 5.6% | 16 |
| unique value | 15 | 3.8% | 7 |
| computed date | 12 | 3.1% | 4 |
| selected or other state | 12 | 3.1% | 5 |
| key chord | 12 | 3.1% | 4 |
| raw HTML or head | 11 | 2.8% | 3 |
| download | 11 | 2.8% | 3 |
| second tab | 3 | 0.7% | 1 |
| layout | 2 | 0.5% | 1 |
| multi-line text | 1 | 0.2% | 1 |
| **Total** | **386** | 100% | 72 |

### Where step judging disagrees with a whole-test verdict

All 10 disagreements run one way: the test is marked expressible, but a step is not. No test marked not expressible turned out to have every step expressible.

| Test | Unexpressible steps |
|---|---|
| Grafana: switching filter type | The plan stops after the third option check. The 14 steps it leaves out include 8 positional ones: a click at the page corner, checkboxes reached through their label's parent, and markers counted inside one panel |
| Supabase Studio: users list refresh | The provider "Email", checked inside the new user's row, is dropped by the plan |
| Rocket.Chat: update profile | The last message and the user-info username need scoping; the plan checks weaker things |
| Saleor Dashboard: app smoke | The app heading inside the frame is found by `first()` |
| Saleor Dashboard: install from manifest | The first installed row, and the Klaviyo row filtered and then taken by `first()` |
| Saleor Dashboard: create category, create collection | A URL pattern with a server-assigned id |
| WordPress Gutenberg: all patterns by default | The exact option list is replaced by per-option checks |
| Real World App: create bank account | A count of list items whose test ids end in record ids, and the second item by position |
| Real World App: bank account form errors | Three "no helper text" checks by element id; the plan checks that one known message is absent |

### Reasons in `report.md` that the sources do not bear out

These do not change any verdict, but `report.md` should be corrected when the tool is next run.

- **Mattermost, "Center channel input box doesn't overlap with RHS".** The reason given is a layout-geometry check. The test at the pinned commit has none. What blocks it is a viewport change and reset mid-test, a reply opened through the last post's id, and a not-focused check.
- **WordPress Gutenberg, "PHP fatal error".** The reason given is a network stub. The failure is in fact set by a cookie that a test plugin reads, and the autosave and its notices go through the editor's data store.
- **Grafana, sandbox app** against **WordPress Gutenberg, allowed patterns.** A plugin enabled through the API counts as seeding in the first and as a UI step in the second. This count treats both as standing preconditions.
- **Mattermost, "Autocomplete should match entries with spaces".** The channel from the suite's standard setup counts as seeding here, but as standing in the other Mattermost tests. This count treats it as standing; the test still fails on the suggestion list's CSS id.
- **Grafana, switching filter type.** The plan covers 20 of the test's 34 steps (see above), so its verdict rests on part of the test.

### By suite

| Suite | Steps | Expressible | Share | Share with seeding set aside | Whole tests expressible |
|---|---:|---:|---:|---:|---:|
| Cal.com (Playwright) | 110 | 49 | 44.5% | 47.5% | 4/10 |
| Grafana (Playwright) | 110 | 75 | 68.1% | 69.4% | 3/10 |
| Supabase Studio (Playwright) | 94 | 61 | 64.8% | 68.5% | 4/10 |
| Rocket.Chat (Playwright) | 179 | 118 | 65.9% | 79.1% | 3/10 |
| Saleor Dashboard (Playwright) | 130 | 116 | 89.2% | 89.2% | 6/10 |
| WordPress Gutenberg (Playwright) | 91 | 53 | 58.2% | 62.3% | 2/10 |
| Mattermost (Cypress) | 136 | 76 | 55.8% | 64.4% | 0/10 |
| MediaWiki (WebdriverIO) | 88 | 82 | 93.1% | 93.1% | 8/10 |
| OpenProject (Capybara with Selenium) | 159 | 106 | 66.6% | 80.3% | 2/10 |
| Cypress Real World App (Cypress, demo app) | 162 | 137 | 84.5% | 84.5% | 6/10 |

### Per test

The steps column counts every step, including hooks; the expressible column includes steps that are standing preconditions.

| Suite | Test | Steps | Expressible | Unexpressible steps by category |
|---|---|---:|---:|---|
| Cal.com | [should render the /apps/installed/\[category\]](https://github.com/calcom/cal.com/blob/56da01b4b1664894b784aca636eccab0c56cc141/apps/web/playwright/ab-tests-redirect.e2e.ts) | 4 | 4 | none |
| Cal.com | [should remove the highlight from the URL](https://github.com/calcom/cal.com/blob/56da01b4b1664894b784aca636eccab0c56cc141/apps/web/playwright/app-list-card.e2e.ts) | 5 | 5 | none |
| Cal.com | [404s must render App Router's not-found page regardless of whether pages router or app router is used](https://github.com/calcom/cal.com/blob/56da01b4b1664894b784aca636eccab0c56cc141/apps/web/playwright/app-router-not-found.e2e.ts) | 4 | 4 | none |
| Cal.com | [Date Overrides](https://github.com/calcom/cal.com/blob/56da01b4b1664894b784aca636eccab0c56cc141/apps/web/playwright/availability.e2e.ts) | 18 | 11 | positional locator 4; computed date 2; CSS or style 1 |
| Cal.com | [should successfully confirm a booking via GET /api/verify-booking-token](https://github.com/calcom/cal.com/blob/56da01b4b1664894b784aca636eccab0c56cc141/apps/web/playwright/booking-confirm-reject.e2e.ts) | 10 | 1 | seeding 3; network stub or assertion 3; backend check 2; computed date 1 |
| Cal.com | [should detect when schedule endpoints are called multiple times for individual user events - beginning of month](https://github.com/calcom/cal.com/blob/56da01b4b1664894b784aca636eccab0c56cc141/apps/web/playwright/booking-duplicate-api-calls.e2e.ts) | 10 | 3 | network stub or assertion 5; computed date 2 |
| Cal.com | [Per day](https://github.com/calcom/cal.com/blob/56da01b4b1664894b784aca636eccab0c56cc141/apps/web/playwright/booking-limits.e2e.ts) | 33 | 8 | computed date 7; reused page value 6; positional locator 4; backend check 4; seeding 3; other 1 |
| Cal.com | [check SSR and OG - User Event Type](https://github.com/calcom/cal.com/blob/56da01b4b1664894b784aca636eccab0c56cc141/apps/web/playwright/booking-pages.e2e.ts) | 11 | 4 | raw HTML or head 7 |
| Cal.com | [should auto-fill untouched phone fields when phone location is selected](https://github.com/calcom/cal.com/blob/56da01b4b1664894b784aca636eccab0c56cc141/apps/web/playwright/booking-phone-autofill.e2e.ts) | 9 | 3 | other 4; seeding 1; positional locator 1 |
| Cal.com | [User can create a seated event (2 seats as example)](https://github.com/calcom/cal.com/blob/56da01b4b1664894b784aca636eccab0c56cc141/apps/web/playwright/booking-seats.e2e.ts) | 6 | 6 | none |
| Grafana | [should detect an issue and fix it](https://github.com/grafana/grafana/blob/a192151a56dfe6fe388b46053e29166e86e0bc22/e2e-playwright/various-suite/advisor.spec.ts) | 16 | 9 | reused page value 4; positional locator 2; other 1 |
| Grafana | [Various Suite test: Bar Gauge Panel](https://github.com/grafana/grafana/blob/a192151a56dfe6fe388b46053e29166e86e0bc22/e2e-playwright/various-suite/bar-gauge.spec.ts) | 4 | 1 | CSS or style 3 |
| Grafana | [should pin the selected menu item and add it as a Bookmarks menu item child](https://github.com/grafana/grafana/blob/a192151a56dfe6fe388b46053e29166e86e0bc22/e2e-playwright/various-suite/bookmarks.spec.ts) | 11 | 5 | positional locator 5; page script 1 |
| Grafana | [Basic path through Explore.](https://github.com/grafana/grafana/blob/a192151a56dfe6fe388b46053e29166e86e0bc22/e2e-playwright/various-suite/explore.spec.ts) | 7 | 7 | none |
| Grafana | [Tests switching filter type updates the UI accordingly](https://github.com/grafana/grafana/blob/a192151a56dfe6fe388b46053e29166e86e0bc22/e2e-playwright/various-suite/filter-annotations.spec.ts) | 34 | 26 | positional locator 8 |
| Grafana | [Loads the app page with the sandbox div wrapper](https://github.com/grafana/grafana/blob/a192151a56dfe6fe388b46053e29166e86e0bc22/e2e-playwright/various-suite/frontend-sandbox-app.spec.ts) | 4 | 3 | CSS or style 1 |
| Grafana | [Should render a sandbox wrapper around the datasource config editor](https://github.com/grafana/grafana/blob/a192151a56dfe6fe388b46053e29166e86e0bc22/e2e-playwright/various-suite/frontend-sandbox-datasource.spec.ts) | 4 | 0 | seeding 2; unique value 1; CSS or style 1 |
| Grafana | [should render random walk configuration fields](https://github.com/grafana/grafana/blob/a192151a56dfe6fe388b46053e29166e86e0bc22/e2e-playwright/various-suite/grafana-datasource-random-walk.spec.ts) | 9 | 9 | none |
| Grafana | [Graph panel is auto-migrated](https://github.com/grafana/grafana/blob/a192151a56dfe6fe388b46053e29166e86e0bc22/e2e-playwright/various-suite/graph-auto-migrate.spec.ts) | 3 | 2 | positional locator 1 |
| Grafana | [Tests various Inspect Drawer scenarios](https://github.com/grafana/grafana/blob/a192151a56dfe6fe388b46053e29166e86e0bc22/e2e-playwright/various-suite/inspect-drawer.spec.ts) | 18 | 13 | selected or other state 5 |
| Supabase Studio | [API access is default on for a new table](https://github.com/supabase/supabase/blob/d4b9d1240c39ad3918e1d80366b3f49b10c49b93/e2e/studio/features/api-access-toggle.spec.ts) | 11 | 8 | seeding 1; other 1; backend check 1 |
| Supabase Studio | [Can send a message to the assistant and receive a response](https://github.com/supabase/supabase/blob/d4b9d1240c39ad3918e1d80366b3f49b10c49b93/e2e/studio/features/assistant.spec.ts) | 9 | 6 | network stub or assertion 3 |
| Supabase Studio | [should automatically refresh users list after creating a user](https://github.com/supabase/supabase/blob/d4b9d1240c39ad3918e1d80366b3f49b10c49b93/e2e/studio/features/auth-users.spec.ts) | 6 | 5 | positional locator 1 |
| Supabase Studio | [editing an array column preserves its type and displays it as type\[\]](https://github.com/supabase/supabase/blob/d4b9d1240c39ad3918e1d80366b3f49b10c49b93/e2e/studio/features/column-editor-types.spec.ts) | 16 | 10 | seeding 2; backend check 2; other 1; positional locator 1 |
| Supabase Studio | [ConnectSheet opens when showConnect=true query param is present](https://github.com/supabase/supabase/blob/d4b9d1240c39ad3918e1d80366b3f49b10c49b93/e2e/studio/features/connect.spec.ts) | 2 | 2 | none |
| Supabase Studio | [can view cron jobs page](https://github.com/supabase/supabase/blob/d4b9d1240c39ad3918e1d80366b3f49b10c49b93/e2e/studio/features/cron-jobs.spec.ts) | 6 | 6 | none |
| Supabase Studio | [generates types for exposed schemas only](https://github.com/supabase/supabase/blob/d4b9d1240c39ad3918e1d80366b3f49b10c49b93/e2e/studio/features/data-api-type-generation.spec.ts) | 9 | 3 | download 6 |
| Supabase Studio | [can view webhooks list page](https://github.com/supabase/supabase/blob/d4b9d1240c39ad3918e1d80366b3f49b10c49b93/e2e/studio/features/database-webhooks.spec.ts) | 4 | 4 | none |
| Supabase Studio | [actions works as expected](https://github.com/supabase/supabase/blob/d4b9d1240c39ad3918e1d80366b3f49b10c49b93/e2e/studio/features/database.spec.ts) | 23 | 14 | seeding 2; other 2; CSS or style 2; download 2; page script 1 |
| Supabase Studio | [links an sb-error-code response to its documentation](https://github.com/supabase/supabase/blob/d4b9d1240c39ad3918e1d80366b3f49b10c49b93/e2e/studio/features/edge-functions.spec.ts) | 8 | 3 | network stub or assertion 4; raw HTML or head 1 |
| Rocket.Chat | [should show the classification banner built from the config in an ABAC room](https://github.com/RocketChat/Rocket.Chat/blob/9f50eafe50c74810fd5a13edc478e946e7c18625/apps/meteor/tests/e2e/abac-classification-banner.spec.ts) | 23 | 14 | seeding 8; CSS or style 1 |
| Rocket.Chat | [an administrator sees who loses access, confirms the update, and only they are removed](https://github.com/RocketChat/Rocket.Chat/blob/9f50eafe50c74810fd5a13edc478e946e7c18625/apps/meteor/tests/e2e/abac-room-attributes-edit.spec.ts) | 25 | 13 | seeding 8; other 2; backend check 2 |
| Rocket.Chat | [a room owner unlocks a locked group from the callout, and only members without the new value are removed](https://github.com/RocketChat/Rocket.Chat/blob/9f50eafe50c74810fd5a13edc478e946e7c18625/apps/meteor/tests/e2e/abac-room-attributes-panel.spec.ts) | 35 | 22 | seeding 9; backend check 3; other 1 |
| Rocket.Chat | [a creator who is not an administrator walks the four steps and the room matches the preview](https://github.com/RocketChat/Rocket.Chat/blob/9f50eafe50c74810fd5a13edc478e946e7c18625/apps/meteor/tests/e2e/abac-room-creation.spec.ts) | 33 | 26 | seeding 5; backend check 2 |
| Rocket.Chat | [Login using credentials and reload to stay logged in](https://github.com/RocketChat/Rocket.Chat/blob/9f50eafe50c74810fd5a13edc478e946e7c18625/apps/meteor/tests/e2e/account-forgetSessionOnWindowClose.spec.ts) | 7 | 4 | second tab 3 |
| Rocket.Chat | [should remove private_key and public_key from localStorage when token expires](https://github.com/RocketChat/Rocket.Chat/blob/9f50eafe50c74810fd5a13edc478e946e7c18625/apps/meteor/tests/e2e/account-login.spec.ts) | 19 | 8 | page script 11 |
| Rocket.Chat | [should show Manage Devices page](https://github.com/RocketChat/Rocket.Chat/blob/9f50eafe50c74810fd5a13edc478e946e7c18625/apps/meteor/tests/e2e/account-manage-devices.spec.ts) | 3 | 3 | none |
| Rocket.Chat | [expect update profile with new name/username](https://github.com/RocketChat/Rocket.Chat/blob/9f50eafe50c74810fd5a13edc478e946e7c18625/apps/meteor/tests/e2e/account-profile.spec.ts) | 13 | 11 | positional locator 2 |
| Rocket.Chat | [should disable and enable email 2FA](https://github.com/RocketChat/Rocket.Chat/blob/9f50eafe50c74810fd5a13edc478e946e7c18625/apps/meteor/tests/e2e/account-security.spec.ts) | 11 | 11 | none |
| Rocket.Chat | [opens the TOTP modal when the REST envelope carries a `totp-required` DDP frame, and resolves on retry](https://github.com/RocketChat/Rocket.Chat/blob/9f50eafe50c74810fd5a13edc478e946e7c18625/apps/meteor/tests/e2e/account-totp.spec.ts) | 10 | 6 | network stub or assertion 2; page script 2 |
| Saleor Dashboard | [TC: APP_SMOKE - \[version\] app renders and loads configuration](https://github.com/saleor/saleor-dashboard/blob/eb1118714c3924904f92a434b409afb3b80443f9/e2e-legacy/tests/appSmokeTests.spec.ts) | 8 | 7 | positional locator 1 |
| Saleor Dashboard | [TC: SALEOR_119 User should be able to install and configure app from manifest #e2e](https://github.com/saleor/saleor-dashboard/blob/eb1118714c3924904f92a434b409afb3b80443f9/e2e-legacy/tests/apps.spec.ts) | 15 | 13 | positional locator 2 |
| Saleor Dashboard | [TC: SALEOR_124 User should be able to create PRODUCT_TYPE attribute with ability to add values, required, public (first input type)](https://github.com/saleor/saleor-dashboard/blob/eb1118714c3924904f92a434b409afb3b80443f9/e2e-legacy/tests/attributes.spec.ts) | 18 | 16 | unique value 2 |
| Saleor Dashboard | [TC: SALEOR_102 Create basic category #e2e #category](https://github.com/saleor/saleor-dashboard/blob/eb1118714c3924904f92a434b409afb3b80443f9/e2e-legacy/tests/categories.spec.ts) | 9 | 8 | other 1 |
| Saleor Dashboard | [TC: SALEOR_97 Create basic channel #e2e #channels](https://github.com/saleor/saleor-dashboard/blob/eb1118714c3924904f92a434b409afb3b80443f9/e2e-legacy/tests/channels.spec.ts) | 11 | 9 | unique value 2 |
| Saleor Dashboard | [TC: SALEOR_112 Create collection #collections  #e2e](https://github.com/saleor/saleor-dashboard/blob/eb1118714c3924904f92a434b409afb3b80443f9/e2e-legacy/tests/collections.spec.ts) | 9 | 8 | other 1 |
| Saleor Dashboard | [TC: SALEOR_199 Create customer #e2e #customer](https://github.com/saleor/saleor-dashboard/blob/eb1118714c3924904f92a434b409afb3b80443f9/e2e-legacy/tests/customers.spec.ts) | 22 | 19 | unique value 3 |
| Saleor Dashboard | [TC: SALEOR_149 Create promotion with Order predicate #discounts #e2e](https://github.com/saleor/saleor-dashboard/blob/eb1118714c3924904f92a434b409afb3b80443f9/e2e-legacy/tests/discounts.spec.ts) | 17 | 17 | none |
| Saleor Dashboard | [TC: SALEOR_105 Issue gift card #e2e #gift](https://github.com/saleor/saleor-dashboard/blob/eb1118714c3924904f92a434b409afb3b80443f9/e2e-legacy/tests/giftCards.spec.ts) | 17 | 15 | reused page value 2 |
| Saleor Dashboard | [TC: SALEOR_29 Correct information on dashboard home page #e2e](https://github.com/saleor/saleor-dashboard/blob/eb1118714c3924904f92a434b409afb3b80443f9/e2e-legacy/tests/home.spec.ts) | 4 | 4 | none |
| WordPress Gutenberg | [navigates forward and back again](https://github.com/WordPress/gutenberg/blob/f539e198d73100100d4d65fd2566479ae0639f0d/test/e2e/specs/editor/various/a11y-region-navigation.spec.js) | 13 | 6 | key chord 6; seeding 1 |
| WordPress Gutenberg | [navigating through the Editor regions four times should land on the Editor top bar region](https://github.com/WordPress/gutenberg/blob/f539e198d73100100d4d65fd2566479ae0639f0d/test/e2e/specs/editor/various/a11y.spec.js) | 8 | 4 | key chord 4 |
| WordPress Gutenberg | [should insert inline image](https://github.com/WordPress/gutenberg/blob/f539e198d73100100d4d65fd2566479ae0639f0d/test/e2e/specs/editor/various/adding-inline-tokens.spec.js) | 17 | 12 | page script 2; unique value 1; CSS or style 1; key chord 1 |
| WordPress Gutenberg | [should insert a block pattern](https://github.com/WordPress/gutenberg/blob/f539e198d73100100d4d65fd2566479ae0639f0d/test/e2e/specs/editor/various/adding-patterns.spec.js) | 6 | 6 | none |
| WordPress Gutenberg | [deselecting all blocks should set `allowedBlocks` to empty array](https://github.com/WordPress/gutenberg/blob/f539e198d73100100d4d65fd2566479ae0639f0d/test/e2e/specs/editor/various/allowed-blocks.spec.js) | 7 | 5 | seeding 1; page script 1 |
| WordPress Gutenberg | [should show all patterns by default](https://github.com/WordPress/gutenberg/blob/f539e198d73100100d4d65fd2566479ae0639f0d/test/e2e/specs/editor/various/allowed-patterns.spec.js) | 6 | 5 | other 1 |
| WordPress Gutenberg | [keeps the animation in every sub-size of an animated GIF](https://github.com/WordPress/gutenberg/blob/f539e198d73100100d4d65fd2566479ae0639f0d/test/e2e/specs/editor/various/animated-image-subsizes.spec.ts) | 9 | 2 | backend check 5; seeding 2 |
| WordPress Gutenberg | [User Mention: should not trigger mention when the immediately preceding character is not a space](https://github.com/WordPress/gutenberg/blob/f539e198d73100100d4d65fd2566479ae0639f0d/test/e2e/specs/editor/various/autocomplete-and-mentions.spec.js) | 10 | 6 | seeding 2; other 1; page script 1 |
| WordPress Gutenberg | [PHP fatal error](https://github.com/WordPress/gutenberg/blob/f539e198d73100100d4d65fd2566479ae0639f0d/test/e2e/specs/editor/various/autosave-failure-notice.spec.js) | 6 | 3 | page script 2; other 1 |
| WordPress Gutenberg | [should save to sessionStorage](https://github.com/WordPress/gutenberg/blob/f539e198d73100100d4d65fd2566479ae0639f0d/test/e2e/specs/editor/various/autosave.spec.js) | 9 | 4 | page script 4; key chord 1 |
| Mattermost | [should load a user who joins the channel](https://github.com/mattermost/mattermost/blob/7709b2f9a5b6739be5580218780740c54b210577/e2e-tests/cypress/tests/integration/channels/messaging/at_mention_loading_spec.ts) | 7 | 2 | seeding 4; page script 1 |
| Mattermost | [should be always highlighted](https://github.com/mattermost/mattermost/blob/7709b2f9a5b6739be5580218780740c54b210577/e2e-tests/cypress/tests/integration/channels/messaging/at_mentions_user_spec.js) | 5 | 3 | reused page value 1; CSS or style 1 |
| Mattermost | [MM-T132 Identical Message Drafts - Autocomplete shown in each channel](https://github.com/mattermost/mattermost/blob/7709b2f9a5b6739be5580218780740c54b210577/e2e-tests/cypress/tests/integration/channels/messaging/autocomplete_shown_each_channel_spec.js) | 18 | 13 | CSS or style 4; seeding 1 |
| Mattermost | [MM-T2199 @ autocomplete - username](https://github.com/mattermost/mattermost/blob/7709b2f9a5b6739be5580218780740c54b210577/e2e-tests/cypress/tests/integration/channels/messaging/autocomplete_spec.js) | 12 | 5 | seeding 4; reused page value 2; CSS or style 1 |
| Mattermost | [MM-T1662_1 Autocomplete should match entries with spaces](https://github.com/mattermost/mattermost/blob/7709b2f9a5b6739be5580218780740c54b210577/e2e-tests/cypress/tests/integration/channels/messaging/autocomplete_with_space_spec.js) | 3 | 2 | CSS or style 1 |
| Mattermost | [MM-T210 Center channel input box doesn't overlap with RHS](https://github.com/mattermost/mattermost/blob/7709b2f9a5b6739be5580218780740c54b210577/e2e-tests/cypress/tests/integration/channels/messaging/center_channel_rhs_overlap_spec.js) | 17 | 12 | layout 2; reused page value 2; other 1 |
| Mattermost | [MM-T1630 - "Jump" to convo works every time for a conversation](https://github.com/mattermost/mattermost/blob/7709b2f9a5b6739be5580218780740c54b210577/e2e-tests/cypress/tests/integration/channels/messaging/channel_and_posts_links_spec.js) | 18 | 11 | reused page value 5; positional locator 2 |
| Mattermost | [MM-14490 show/hide properly menu dividers](https://github.com/mattermost/mattermost/blob/7709b2f9a5b6739be5580218780740c54b210577/e2e-tests/cypress/tests/integration/channels/messaging/channel_menu_spec.js) | 17 | 10 | CSS or style 4; seeding 3 |
| Mattermost | [MM-T179 Channel is removed from Unreads section if user navigates out of it via permalink](https://github.com/mattermost/mattermost/blob/7709b2f9a5b6739be5580218780740c54b210577/e2e-tests/cypress/tests/integration/channels/messaging/channel_read_after_permalink_spec.js) | 30 | 11 | seeding 6; reused page value 6; positional locator 4; raw HTML or head 3 |
| Mattermost | [MM-T104 Can `Show More` and `Show Less` on long posts, Markdown in long posts](https://github.com/mattermost/mattermost/blob/7709b2f9a5b6739be5580218780740c54b210577/e2e-tests/cypress/tests/integration/channels/messaging/collapsed_message_spec.js) | 9 | 7 | multi-line text 1; reused page value 1 |
| MediaWiki | [should show that an empty category has no members](https://github.com/wikimedia/mediawiki/blob/d741faf07efd77263ec4e41b268378d5a4b2f76f/tests/selenium/specs/category.js) | 10 | 10 | none |
| MediaWiki | [should be previewable](https://github.com/wikimedia/mediawiki/blob/d741faf07efd77263ec4e41b268378d5a4b2f76f/tests/selenium/specs/page.js) | 9 | 9 | none |
| MediaWiki | [should be deletable](https://github.com/wikimedia/mediawiki/blob/d741faf07efd77263ec4e41b268378d5a4b2f76f/tests/selenium/specs/pageadmin.js) | 8 | 8 | none |
| MediaWiki | [shows page creation](https://github.com/wikimedia/mediawiki/blob/d741faf07efd77263ec4e41b268378d5a4b2f76f/tests/selenium/specs/recentchanges.js) | 9 | 9 | none |
| MediaWiki | [should not see signup form fields relevant to named users](https://github.com/wikimedia/mediawiki/blob/d741faf07efd77263ec4e41b268378d5a4b2f76f/tests/selenium/specs/temporaryuser.js) | 9 | 9 | none |
| MediaWiki | [should be able to create account](https://github.com/wikimedia/mediawiki/blob/d741faf07efd77263ec4e41b268378d5a4b2f76f/tests/selenium/specs/temporaryuseraccount.js) | 9 | 6 | unique value 3 |
| MediaWiki | [should be able to create account](https://github.com/wikimedia/mediawiki/blob/d741faf07efd77263ec4e41b268378d5a4b2f76f/tests/selenium/specs/user.js) | 5 | 2 | unique value 3 |
| MediaWiki | [should list member pages and subcategories](https://github.com/wikimedia/mediawiki/blob/d741faf07efd77263ec4e41b268378d5a4b2f76f/tests/selenium/specs/category.js) | 13 | 13 | none |
| MediaWiki | [should be creatable](https://github.com/wikimedia/mediawiki/blob/d741faf07efd77263ec4e41b268378d5a4b2f76f/tests/selenium/specs/page.js) | 7 | 7 | none |
| MediaWiki | [should be restorable](https://github.com/wikimedia/mediawiki/blob/d741faf07efd77263ec4e41b268378d5a4b2f76f/tests/selenium/specs/pageadmin.js) | 9 | 9 | none |
| OpenProject | [shows help text modal on clicking help text link](https://github.com/opf/openproject/blob/6fc7887f56a0a8892c49264eb330cdce48530a86/spec/features/projects/attribute_help_texts_spec.rb) | 14 | 8 | seeding 3; CSS or style 3 |
| OpenProject | [renders only required project attribute](https://github.com/opf/openproject/blob/6fc7887f56a0a8892c49264eb330cdce48530a86/spec/features/projects/copy_spec.rb) | 19 | 7 | seeding 12 |
| OpenProject | [can navigate to the create project page](https://github.com/opf/openproject/blob/6fc7887f56a0a8892c49264eb330cdce48530a86/spec/features/projects/create_spec.rb) | 5 | 5 | none |
| OpenProject | [destroys the project](https://github.com/opf/openproject/blob/6fc7887f56a0a8892c49264eb330cdce48530a86/spec/features/projects/destroy_spec.rb) | 16 | 12 | backend check 3; seeding 1 |
| OpenProject | [hides the field whose functionality is presented otherwise](https://github.com/opf/openproject/blob/6fc7887f56a0a8892c49264eb330cdce48530a86/spec/features/projects/edit_settings_spec.rb) | 4 | 2 | seeding 2 |
| OpenProject | [exports the visible projects](https://github.com/opf/openproject/blob/6fc7887f56a0a8892c49264eb330cdce48530a86/spec/features/projects/export_spec.rb) | 10 | 4 | seeding 3; download 3 |
| OpenProject | [allows favoriting and unfavoriting projects](https://github.com/opf/openproject/blob/6fc7887f56a0a8892c49264eb330cdce48530a86/spec/features/projects/favorite_spec.rb) | 35 | 23 | selected or other state 4; seeding 3; other 2; positional locator 2; backend check 1 |
| OpenProject | [navigates to the projects#index page](https://github.com/opf/openproject/blob/6fc7887f56a0a8892c49264eb330cdce48530a86/spec/features/projects/global_menu_item_spec.rb) | 5 | 5 | none |
| OpenProject | [allows adding and removing modules](https://github.com/opf/openproject/blob/6fc7887f56a0a8892c49264eb330cdce48530a86/spec/features/projects/modules_spec.rb) | 38 | 32 | CSS or style 4; seeding 2 |
| OpenProject | [can deselect the current project and keep the module](https://github.com/opf/openproject/blob/6fc7887f56a0a8892c49264eb330cdce48530a86/spec/features/projects/navigation_spec.rb) | 13 | 8 | CSS or style 3; seeding 1; selected or other state 1 |
| Cypress Real World App | [should redirect unauthenticated user to signin page](https://github.com/cypress-io/cypress-realworld-app/blob/0729f68ac220f7cda4ad09c5693dba11d7c532c6/cypress/tests/ui/auth.spec.ts) | 4 | 4 | none |
| Cypress Real World App | [creates a new bank account](https://github.com/cypress-io/cypress-realworld-app/blob/0729f68ac220f7cda4ad09c5693dba11d7c532c6/cypress/tests/ui/bankaccounts.spec.ts) | 15 | 13 | CSS or style 1; positional locator 1 |
| Cypress Real World App | [navigates to the new transaction form, selects a user and submits a transaction payment](https://github.com/cypress-io/cypress-realworld-app/blob/0729f68ac220f7cda4ad09c5693dba11d7c532c6/cypress/tests/ui/new-transaction.spec.ts) | 25 | 21 | positional locator 2; selected or other state 1; backend check 1 |
| Cypress Real World App | [User A likes a transaction of User B; User B gets notification that User A liked transaction ](https://github.com/cypress-io/cypress-realworld-app/blob/0729f68ac220f7cda4ad09c5693dba11d7c532c6/cypress/tests/ui/notifications.spec.ts) | 23 | 10 | network stub or assertion 5; CSS or style 5; positional locator 3 |
| Cypress Real World App | [toggles the navigation drawer](https://github.com/cypress-io/cypress-realworld-app/blob/0729f68ac220f7cda4ad09c5693dba11d7c532c6/cypress/tests/ui/transaction-feeds.spec.ts) | 8 | 8 | none |
| Cypress Real World App | [transactions navigation tabs are hidden on a transaction view page](https://github.com/cypress-io/cypress-realworld-app/blob/0729f68ac220f7cda4ad09c5693dba11d7c532c6/cypress/tests/ui/transaction-view.spec.ts) | 9 | 7 | positional locator 1; other 1 |
| Cypress Real World App | [renders the user settings form](https://github.com/cypress-io/cypress-realworld-app/blob/0729f68ac220f7cda4ad09c5693dba11d7c532c6/cypress/tests/ui/user-settings.spec.ts) | 7 | 7 | none |
| Cypress Real World App | [should redirect to the home page after login](https://github.com/cypress-io/cypress-realworld-app/blob/0729f68ac220f7cda4ad09c5693dba11d7c532c6/cypress/tests/ui/auth.spec.ts) | 4 | 4 | none |
| Cypress Real World App | [should display bank account form errors](https://github.com/cypress-io/cypress-realworld-app/blob/0729f68ac220f7cda4ad09c5693dba11d7c532c6/cypress/tests/ui/bankaccounts.spec.ts) | 49 | 46 | CSS or style 3 |
| Cypress Real World App | [navigates to the new transaction form, selects a user and submits a transaction request](https://github.com/cypress-io/cypress-realworld-app/blob/0729f68ac220f7cda4ad09c5693dba11d7c532c6/cypress/tests/ui/new-transaction.spec.ts) | 18 | 17 | selected or other state 1 |

## Risks

- **Step splitting is a judgement.** Helpers count as the steps their names show, so suites built on page objects and helpers (Saleor Dashboard, Mattermost, Grafana's inspect drawer) count fewer steps than they perform. Loops count once, so the 25 posts in Mattermost's jump test count as two steps. A different split would move the share by a few points either way.
- **Locators were not run against the apps.** CSS-located buttons and inputs are assumed to have a usable role or label. Steps marked positional assume the text is not unique. Both need a run against a live app to confirm.
- **The standing-precondition rule carries 87 steps.** Counting them against the plan takes the share from 69.3% to 62.4%. The 22 visual snapshots carry 1.7 points.
- **One judge.** Every step was judged by one reader, with no second reading. The ten disagreements above show that the rule can be read more and less strictly.
- **The sample is the first test of each file.** As in `report.md`, it is not a random draw from each suite.
- **This is not the kill criterion's measure.** Don't read 69.3% as "nearly 70%": the criterion counts whole intents, and on that count the result is 38%.
