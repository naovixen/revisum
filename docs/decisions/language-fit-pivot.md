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
