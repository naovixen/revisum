# Build the demo path first

## In short

- The founder approved (2026-11-10) moving the demo forward: the remaining queue is ordered so that one real app can go from a pull request to an independent run, accessibility findings, a review queue and masked images as early as the specs allow.
- **Only the order changes.** Every spec, criterion, guarantee and kill criterion stays as approved. No spec moves to another milestone as a whole, and M3 and M4 keep their exits.
- Three items wait until after the demo: SPEC-29 with SPEC-10's coverage comparison, SPEC-15, and the parts of SPEC-16 a demo doesn't use.

## Decisions

| Decision | Why | Confidence |
|---|---|---|
| Build in this order: SPEC-09, 10, 11, 12, 14, 13, SPEC-35's M3 part with SPEC-36's labels, then a demo part of SPEC-16 | Follows each spec's Dependencies section; ends at the first point a person can run it | high |
| SPEC-14 comes before SPEC-13 | SPEC-13 depends on SPEC-14 for events (AC-SPEC-13-05 appends an audit event); the old order had them the wrong way round | high |
| The demo part of SPEC-16 is `run` (plans and `--suite`), `review`, their JSON output and exit codes, and the Action with its `suites` input | SPEC-35 places `run --suite` and the Action input with SPEC-16; the same early wiring as `draft` (`drafting-earlier.md`) | high |
| AC-SPEC-16-11 and 12 stay in the demo part, with the findings `START.md` holds for SPEC-16 where they touch it | They prove `run`'s replay and egress in a real container; a demo must not run on a weaker path than the release | high |
| SPEC-10's criteria 11 to 13 move to SPEC-29, which comes first after the demo | They read SPEC-29's coverage report, and SPEC-29 depends on SPEC-10's engines | high |
| The demo uses a real Playwright Test suite, with the dependency review finding 116 already requires | Evidence mode has only run against a stand-in | high |
| SPEC-09 and SPEC-14 get their trust-path reviews and `npm run check:linux` before anyone outside sees the demo | The build loop reviews these at a milestone exit, which now falls after the demo | high |
| Phase 6 of the refactor may run alongside the demo path, and doesn't hold it up | `START.md` already lets it run alongside M3 | medium |

## Findings

- **Left out on purpose.** The founder's longer-term aims need their own spec and approval, and are not added here: AI exploration on every pull request, demo video, narrated material for product managers. SPEC-17's stills and release notes stay in M4, and ACR drafts stay in SPEC-26.
- The demo's images are SPEC-12's masked captures and PR image, so it needs nothing beyond the approved specs.
- SPEC-29 depends on SPEC-17's claim lint, and SPEC-10's AC-06 on a claim lint of its own. The old queue had this tension too; SPEC-29's session resolves it as `docs/build-loop.md` says.
- Evidence runs keep `mode: 'evidence'`, `host` and the guarantee statement on every output (AC-SPEC-35-16). The demo claims nothing new.

## Risks

- **A partial SPEC-16 can spread.** Mitigation: its remaining criteria stay queued in M4, unticked until built, and SPEC-16 is ticked only when all of them pass.
- **The demo isn't a release.** No npm publish, provenance or SBOM until M4, and AC-SPEC-16-03 needs a public repository, which is the founder's to set up.
- **The accessibility numbers wait.** "Verifies N of M" comes after the demo, so the demo shows findings without a published coverage figure.
- **A demo can flatter.** One app shows it works once, and not that anyone will pay. The kill criteria in `E:\core\docs\09-mvp-plan.md` §6 still apply.
