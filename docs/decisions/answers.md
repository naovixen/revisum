# Answers found by research

Questions the build answered from the research repo or the web, without the founder. One row each, newest last. The founder can overrule any row.

| Date | Spec | Question | Answer | Source |
|---|---|---|---|---|
| 2026-10-28 | SPEC-27 | What is "the docs build" for error-code anchors (AC-SPEC-27-06)? | Research gives only the anchor form `errors#<code>`, no page or build. Settled: `docs/errors.md` with one `## <code>` heading per code, checked by `npm run lint` | `E:\core\docs\specs\SPEC-27-shared-types-and-events.md` (scope, interfaces, AC-06); nothing in `13` or `04` |
| 2026-10-28 | SPEC-01 | How are the coverage study (AC-01) and the schema build (AC-10) shaped, given no interface, no release build and no new engine dependency? | A data file of sampled intents decoded by engine's `assessCoverage`; a hand-built `planJsonSchema()` checked in `npm run lint` against the stored schema, the golden plans and the changelog. Other open points (vacuity code, mapping keys, frame depth, project lists) settled from the spec's own text | SPEC-01 "Build notes"; spec scope and interfaces |
