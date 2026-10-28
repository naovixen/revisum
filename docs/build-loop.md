# Build loop (main session only)

How the main session runs the plan on its own. Helpers never read this; their brief is enough.

## In short

- Say *"Continue the build"*. The session takes the next unchecked spec in `START.md`, builds it, commits it, and moves on.
- It answers its own questions from the specs, then the research repo, then the web. It stops only for the reasons in "Stop and ask", or at a milestone exit.
- Everything needed to resume lives in files (`START.md`, `docs/decisions/answers.md`, `docs/decisions/velocity.md`), so any fresh session can continue.

## One spec

0. **Align.** Where the spec's types or criteria contradict the seeded tests, the spec follows the tests and new rules become marked additions (SPEC-27 is the example). Commit as a docs change.
1. **Tests.** A fresh helper gets `docs/prompts/session-tests.md` with `<NN>` filled in. Check its change is test-set only, then commit it alone.
2. **Code.** A fresh helper gets `docs/prompts/session-code.md` with `<NN>` and `<TESTS-COMMIT>`. If it says a test looks wrong, stop and ask (never fix a committed test). When `npm run check` is green, commit.
3. **Linux.** If the spec touches browsers, screenshots, fonts or replay, run `npm run check:linux` (start Docker Desktop if needed).
4. **Record.** Add a row to `docs/decisions/velocity.md`, tick the spec in `START.md`, and commit both.

Before every commit: `git diff --cached --name-only | node tools/check-tests-apart.ts`.

## Questions

Resolve each in this order, and stop at the first that answers it:

1. **This repo.** The spec, `docs/system-design.md`, `docs/glossary.md` and `docs/decisions/answers.md`. Search; don't read whole files.
2. **The research repo** (`E:\core`, read-only). Start an `Explore` helper with the question and the doc numbers the spec cites. Ask for an answer of at most 10 lines with document and section.
3. **The web.** A helper searches in standard mode first, and returns an answer of at most 10 lines with links.
4. **The founder.** See "Stop and ask".

Record every answer from steps 2 and 3 as one row in `docs/decisions/answers.md`. A finding that changes a design choice gets its own record in `docs/decisions/`.

## Stop and ask

Stop, even if research suggests an answer, when the next step would:

- spend money, or need an account, a purchase or any action outside this machine and the repo;
- change approved scope, a milestone, the cut list, a kill criterion, or what a spec promises;
- change a committed test;
- weaken security, isolation, egress control, credentials or the deny rules, or change a licence;
- choose between sources that disagree, when the choice is costly to reverse.

Also stop when a kill-criterion date passes unmet (see `START.md`).

Before stopping, commit finished work. Then ask one message with the question, two to four options and a recommendation, so the founder can answer in a line.

## Milestone exit

When the last spec of a milestone is committed:

1. Run `npm run check:linux`.
2. Start one review helper (`docs/prompts/session-review.md`) for each trust-path spec in the milestone: SPEC-02, 03, 04, 07, 09 and 14. Fix findings through the normal loop.
3. Compare the milestone against `docs/system-design.md` §7 and the kill criteria in `E:\core\docs\09-mvp-plan.md` §6. Record the result in `docs/decisions/milestone-exits.md`.
4. Stop. The founder pushes and checks CI. Start the next milestone in a fresh session.

## Keeping context and tokens small

- **The main session reads summaries, not files.** Use `git diff --stat`, `grep` and helper reports. Send long command output to a file in the scratchpad and read only the summary lines.
- **One helper per step**, with its brief plus at most 20 lines of known facts. Don't repeat what `CLAUDE.md` says; helpers load it.
- **Helpers iterate on one package** (`npm test -w <package>`) and run `npm run check` once at the end.
- **Research is narrow.** The `Explore` helper reads excerpts, not whole research docs. Use the web only when the repo can't answer.
- **Reviews only at milestone exits**, and only for trust-path specs.
- **A fresh session per milestone.** It starts from `START.md`, not from a long conversation.
