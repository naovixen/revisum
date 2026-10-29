# Language fit: pivot to evidence mode, with opt-in unsafe features

## In short

- The plan-language coverage study, judged strictly, found plan 1.2 expresses 18 of 50 fresh test intents (36%) and 68 of 150 overall (45%), against the 70% language-fit kill criterion (`docs/coverage-study/rerun-1.2.md`).
- The founder chose (2026-10-28) the research's recorded fallback: **pivot to evidence mode around existing Playwright tests**, and **let users enable unsafe features** in the plan language. The coverage is then re-measured with unsafe features enabled, to see where it reaches.
- The closed, safe language stays the default. Unsafe features are off unless a person enables them in the trusted project file. Every output resting on them says so.

## Decisions

| Decision | Why | Confidence |
|---|---|---|
| Add evidence mode: run a team's existing Playwright suites in the isolated runner and wrap them with Revisum's evidence (result file, report, accessibility audit, review queue, recorded approvals) | The research's recorded response to the language-fit criterion (`E:\core\docs\09-mvp-plan.md` §6); teams get value without rewriting tests | high |
| Add opt-in unsafe features: escape hatches the safe language leaves out (CSS and XPath locators, page scripts, direct database setup through a declared command) | The founder's decision; the study's main remaining gaps are exactly these | high |
| Unsafe features and evidence mode are enabled only in the trusted project file, approved like any trusted file (SPEC-02), and lower the guarantee label of every output resting on them | Keeps "approved by a person" and honest labelling; nothing silently weakens the safe default | high |
| Re-measure coverage with unsafe features enabled, reported beside the safe-only share | The founder asked to see where it reaches; the safe-only share stays the honest measure of the safe language | high |

## Findings

- The remaining fresh-sample gaps under 1.2: database seeding or checks (8 of 32), CSS classes, styles or CSS-only locators (7), page scripts or editor data stores (3), unnamed elements (3), record-id lookups (3).
- About half of the 68 expressible intents rest on unbuilt driver parts or stated assumptions; without assumptions the share is 34%.

## Risks

- Evidence mode and unsafe features weaken the core promise that an AI-written test can't act outside the plan. Mitigation: off by default, enabled only by a person in trusted config, labelled on every output, and never counted as "verified" evidence.
- Running a team's own test code means arbitrary code runs in the runner: the isolation and egress controls (SPEC-07) become load-bearing for evidence mode.
- The kill criterion itself is unchanged; this record does not claim it is met.

## Impact on existing specs and milestones

**In short:** two new specs, no redesign. SPEC-35 adds evidence mode; SPEC-36 adds plan 1.3 with opt-in unsafe features. The closed path keeps its behaviour and hashes. The changes below land with the new specs' commits, each in the spec or doc it names; this record makes none of them.

### Specs

| Spec | Change |
|---|---|
| SPEC-01 | Non-goal "CSS, XPath, script or sleep steps" becomes "in the closed language"; the parser reads the project's enabled unsafe features (SPEC-36) |
| SPEC-02 | `ProjectData` gains `evidenceMode` and `unsafeFeatures`; declared suite paths join the trusted files, so edited tests raise `changed-with-code` |
| SPEC-03 | Adds `inline-script-in-proposal`. The static irreversible check can't read names from CSS or XPath locators, but the runtime guard still does. Scripts and commands bypass the runtime guard, as SPEC-36 states |
| SPEC-04 | The leak scan covers suite outputs and trace archive entries; `reveal`'s allow-list gains runner's workload-environment module |
| SPEC-06 | Drivers resolve CSS and XPath locators, read classes, styles and attributes, and run declared page scripts; `driver-cdp` renders trace snapshots offline for the audit |
| SPEC-07 | Runner gains `WorkloadRunner` (team image by digest), the `process` egress channel and TCP allowances for declared database services |
| SPEC-08 | Manifest gains `evidence`, `unsafeFeatures` and `unsafeDeclarations`; replay refuses evidence runs (`replay-not-claimed`) and reuses recorded command outputs |
| SPEC-09 | Masks Revisum's re-rendered snapshot captures; suite screenshots are never embedded |
| SPEC-10 | `A11yFinding.source` (`live-page`, `recorded-snapshot`); keyboard and focus probes don't run on snapshots |
| SPEC-11 | `RunResult` gains `mode`, `guarantees`, `unsafeFeatures` and `suite`; every exporter prints the labels |
| SPEC-12 | Banner and PR verdict line carry the evidence-mode or unsafe label and the lost guarantees |
| SPEC-13 | `ReviewReason` gains `recorded-snapshot`, `suite-artefact-withheld` and `changed-test` |
| SPEC-15, SPEC-21 | Metrics and levels use closed, isolated plan runs only; evidence and unsafe counts are shown beside them |
| SPEC-16 | `run --suite <name>`, the Action's `suites` input and `doctor` checks for workload images and unsafe declarations |
| SPEC-17 | The claim lint bars "verified", "hermetic", "isolated", "replayable" and "closed language" on evidence and unsafe outputs |
| SPEC-19 | Unchanged. Its plug-in runs plans inside a suite, the reverse of evidence mode (a suite inside the runner) |
| SPEC-27 | `GuaranteeLevel` keeps `isolated` and `host`, but `host` now means "not every guarantee holds; see the statement". Adds `GuaranteeStatement`, `UnsafeFeature` and the new unions |
| SPEC-28 | Readable form for 1.3 deferred; `draft` never emits unsafe features |
| SPEC-30 | SPEC-36's first commit dates its "1.2 (unreleased)" changelog entry, since every 1.2 parser part has landed |
| SPEC-32 | Non-goal "direct database connections and shell or script commands" now reads "in the closed language; see SPEC-36's declared commands" |

### `docs/system-design.md`

| Section | Change |
|---|---|
| In short, Decisions | Add: the closed language is the default; evidence mode and unsafe features are opt-in in trusted config and labelled `host` |
| §1 Tech stack | The isolation row gains team workload images by digest |
| §3 Packages | No new package. `runner` gains the workload runner; `engine` gains the suite-report and trace decoders |
| §4 One run | A second entry route: declared suite, then trust, workload container, decoded outputs, snapshot audit and the same result stages. The parse stage accepts unsafe features only when enabled |
| §5 Folder structure | Customer repositories may hold `plans/scripts/` (trusted) |
| §7 Milestones | M1 to M4 rows gain the SPEC-35 and SPEC-36 slices below |
| Risks | Add: evidence mode runs team code, so the runner's isolation is load-bearing |

`docs/glossary.md` gains rows for evidence mode, suite, workload image, guarantee statement, unsafe feature, page script and database command. The guarantee-level row's meaning changes as for SPEC-27 above.

### Proposed placement in `START.md`

| Milestone | Insert | Where |
|---|---|---|
| M1 | SPEC-35 declaration, suite-file trust, report decoder, result mapping and labels (no containers) | After SPEC-28, before SPEC-00 remaining criteria |
| M1 | SPEC-36 plan 1.3 parser parts, declarations, gate rules and labels; then **measure** the "1.3 with unsafe features" share with parsed plans | Straight after the SPEC-35 item |
| M2 | SPEC-35 workload runner, suite run, egress, traces and manifest | Straight after SPEC-07, before the SPEC-30 to 33 driver parts |
| M2 | SPEC-36 driver parts (CSS, XPath, DOM checks, page scripts), then database commands | With the SPEC-30 to 33 driver parts |
| M3 | SPEC-35 snapshot audit, masked captures, report, PR comment and review queue; SPEC-36 labels in exporters | After SPEC-13 |
| M4 | SPEC-35 `run --suite` and Action input; SPEC-36 `doctor` checks and claim-lint wording | With SPEC-16 and SPEC-17 |

The language-fit row in the kill-criterion table stays as it is, with a note that the response (this record) is under way.

## Founder's answers (2026-10-28)

All yes:
1. Evidence mode's runner comes before the remaining plan-language driver parts in M2.
2. `host` means "not every guarantee holds"; every output resting on it lists which guarantees hold and which don't.
3. In phase 1, evidence mode audits recorded page snapshots, not live pages; keyboard and focus checks become review items.
4. Evidence mode supports Playwright only; Cypress and others wait for a partner to ask.
5. The measured re-run on plan 1.3 uses strict judging, without the projection's generous assumptions.

The placement above is now the queue in `START.md`.

## Founder's answer at the M1 exit (2026-10-29)

The measured share stays under the threshold: 36% fresh on 1.2 without escape hatches, 44% fresh on 1.3 even counting unsafe features. The founder recorded this pivot as the response to the language-fit signal, the one `E:\core\docs\09-mvp-plan.md` §6 lists, so the criterion no longer stops the build on 2026-11-23. The threshold is unchanged and is still reported as unmet. The build goes on until it is demoable; the founder then judges, by using it, whether the product is worthwhile.

## Projected coverage with unsafe features

**In short:** a **projection**, not a measurement. The parser can't check 1.3 plans yet. With every SPEC-36 feature enabled, judged by the same strict whole-test rule as `docs/coverage-study/rerun-1.2.md`, the shares would be:

| Sample | Closed 1.2 (measured) | 1.2 + SPEC-36 (projected) | Without database commands |
|---|---:|---:|---:|
| Original | 50/100 (50%) | **86/100 (86%)** | 73/100 (73%) |
| Fresh | 18/50 (36%) | **38/50 (76%)** | 32/50 (64%) |
| Both | 68/150 (45%) | **124/150 (83%)** | 105/150 (70%) |

- **This does not meet the kill criterion.** That criterion counts intents expressible *without* an escape hatch, and these features are escape hatches. The criterion's share stays 36% on the fresh sample.
- Evidence mode is not counted here. It runs a Playwright suite whole, at the `host` level. It covers 6 of the 10 study suites (90 of 150 intents), and 16 of the 26 intents still out below.

### Judging rules added for SPEC-36

- **CSS and XPath** count in two cases. One is where the source finds the element by CSS, XPath or a Playwright `filter`. The other is where a selector reaches the same element: a record-id prefix (`[data-test^="transaction-item-"]`), `:focus`, or `hasText` and `inside`. Selectors hold no run values; `hasText` may.
- **A page script** counts only where the source itself runs code in the page: `page.evaluate`, the editor's data store or the app's state store. It never stands in for a user action, a cookie or a computation in test code.
- **A database command** counts only where the source seeds or reads the database directly (factories, Prisma, a database helper). It assumes the team moves that code into a declared command, much as an HTTP seeding route would otherwise need. It doesn't count for in-process server stubs, sent-mail checks or HTTP calls with tokens made at run time.

### Findings

- **56 intents move up** (36 original, 20 fresh). What they rest on (an intent may rest on several):

| Rests on | Original | Fresh | Both |
|---|---:|---:|---:|
| CSS or XPath locators | 21 | 14 | 35 |
| CSS or XPath only, no other unsafe feature | 16 | 8 | 24 |
| Database commands | 13 | 6 | 19 |
| Page scripts | 5 | 3 | 8 |
| DOM checks (class, style, attribute) | 3 | 4 | 7 |
| A stated assumption | 7 | 3 | 10 |

- **The assumptions behind the 10:**
  - Rocket.Chat profile: judged on its steps, because the test is skipped in the suite;
  - Gutenberg region navigation (2): pressing at `:focus` assumes focus stays in the top document;
  - Mattermost MM-T2199 and MM-T1630, and the fresh MM-T4688: the last post by position stands in for the id read from the page;
  - OpenProject "destroys the project": the app's job worker runs;
  - Real World App likes: like and notification items are found by test-id prefix;
  - Grafana panel styles: the "Collapse" name comes from `aria-label`;
  - Gutenberg last-block delete: typing at the caret is a `fill` on `:focus` inside the canvas frame.
- **Firm and closest to the safe language.** Without database commands or new assumptions, the fresh share is 29 of 50 (58%).
- **All 56 rest on unbuilt parts:** SPEC-36's parser and driver parts, and for 19 a seed command the team writes.

**Still not expressible (26).** By cause:

| Cause | Intents |
|---|---|
| Text built from a run value (cut or joined) | Saleor gift card; Mattermost MM-T132, MM-T179, MM-T1226 and MM-T1224; Gutenberg scaled image names |
| Branching or loops | Grafana advisor; Saleor stock settings; Cal.com "Per day" (dates in a loop) |
| Another user, process or in-process server state | Rocket.Chat second viewer; Mattermost mute (run-time token); OpenProject subproject (server stub) and template step (inline job, sent mail) |
| Reads outside the language | Supabase assistant (streamed body); Gutenberg GIF frame counts; Grafana payload size (performance metrics); Supabase whole-JSON equality; Real World App cookie expiry |
| Others, one each | Cal.com sum of two request counts; Cal.com either-or phone check; Grafana page-corner click; Supabase clipboard lines within one block; Rocket.Chat stub echoing a request id; Gutenberg cookie-set failure; Mattermost mid-test viewport; Mattermost weekday in another locale |

### Risks

- **One judge, as before, and generous categories.** Record-id prefixes and `:focus` were judged equivalent to the source. A stricter reader could drop about 10.
- **Database commands carry the most weight:** 19 of the 56. They need each team to write seed commands, as declared calls needed an HTTP route. Without them the fresh share is 64%.
- **The share measures what can be written, not what is worth writing.** Unsafe plans are brittle, lose the guarantees SPEC-36 lists, and never count as verified evidence.
- **Measure, don't project.** SPEC-36's M1 parser parts let the study parse every one of these plans. Until then, quote only the closed share as the language-fit result.
