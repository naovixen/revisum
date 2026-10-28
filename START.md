# Start here

The founder's checklist and the build queue.

**How you work:** open WebStorm's terminal in `E:\revisum`, run `claude`, and say *"Continue the build."* The session builds the next unchecked specs in order, committing each step, until it needs your answer or reaches a milestone exit. Answer its question, or at a milestone exit read the commits, push, check CI is green, and start a fresh session with the same words. Claude can't push, merge, rebase or tag. How it works: `docs/build-loop.md`.

## Progress

Setup and seed (done):

- [x] Research committed in `E:\core`; research commit recorded
- [x] Image digest pinned; private GitHub repo
- [x] `main` protection: skipped on GitHub Free until the repo goes public at beta
- [x] Dev container locked (used only for CI and `npm run check:linux`)
- [x] Session 0a skeleton, 0b tests, 0c code (SPEC-00, M0)

M1, language and trust:

- [x] SPEC-27 shared types and event sink
- [x] SPEC-01 plan language and parser
- [x] SPEC-02 project trust and approval
- [x] SPEC-03 policy gate (static check and guard logic)
- [x] SPEC-04 secrets and redaction
- [ ] SPEC-30 plan values, positions and keys: parser and engine parts; owns plan language 1.2
- [ ] SPEC-31 page states, metadata, downloads and tabs: parser parts
- [ ] SPEC-32 declared service calls: declarations and request building, against a fake caller
- [ ] SPEC-33 network stubs, request checks and storage: grammar
- [ ] SPEC-34 clock advance and clipboard checks: parser parts
- [ ] Re-run the coverage study on plan 1.2, plus a fresh sample of at least 50, before 2026-11-23
- [ ] SPEC-28 plan authoring (readable format, conversion, `admitDraft`, provenance)
- [ ] SPEC-00 remaining criteria (04, 07, 09, 10, 16, 19, 20; finish 05, 08, 11, 15, 17)
- [ ] M1 exit

M2, driver and isolation (alpha):

- [ ] SPEC-05 target matrix and lock
- [ ] SPEC-06 CDP driver, with SPEC-03's guard wired in
- [ ] SPEC-07 isolated runner and egress
- [ ] SPEC-30 to 33 driver and runner parts (states, downloads, tab, real service caller, stubs, storage)
- [ ] SPEC-08 manifest and replay
- [ ] M2 exit

M3, evidence:

- [ ] SPEC-09 privacy masking
- [ ] SPEC-10 accessibility audit
- [ ] SPEC-29 WCAG test base
- [ ] SPEC-11 result model and exporters
- [ ] SPEC-12 visual report and PR comment
- [ ] SPEC-13 review queue and recorder
- [ ] SPEC-14 audit log and traceability
- [ ] SPEC-15 metrics panel
- [ ] M3 exit

M4, launch (beta):

- [ ] SPEC-16 CLI and GitHub Action
- [ ] SPEC-17 release artefacts and claims (marketing render target and claim lint)
- [ ] SPEC-28 `draft`
- [ ] M4 exit

The queue ends at beta. Phase 2 specs (SPEC-18 onwards) wait for pilots.

## Kill-criterion dates

From `E:\core\docs\09-mvp-plan.md` §6, counted from the plan's day 0, 2026-11-02. The session stops if one passes unmet.

| Signal | Threshold | By |
|---|---|---|
| Language fit | Under 70% of sampled test intents expressible without an escape hatch | 2026-11-23 |
| Velocity | M1 not done | 2027-01-06 |
| Problem fit | Fewer than 5 of 15 discovery calls name verifying AI-built features as a top-3 pain (yours) | 2027-01-25 |
| Driver parity, isolation | Own CDP driver fails the contract tests; egress can't be enforced in CI containers | 2027-03-17 |
| Upkeep | Fixes average over 1.8 h across the first 6 Chromium majors | 2027-03-31 |
| Velocity | M3 not done | 2027-06-07 |

## Setup reference

| Step | How | Check |
|---|---|---|
| Pin the container image | `docker pull`, then `docker inspect --format "{{index .RepoDigests 0}}"` on `mcr.microsoft.com/devcontainers/typescript-node:24-bookworm`. Put the digest in `.devcontainer/devcontainer.json` and `.github/workflows/ci.yml` | The image line ends in `@sha256:` and 64 hex characters |
| Protect `main` (at beta) | GitHub → Settings → Rules → new branch ruleset on `main`: block force pushes, and require the `ci` check | A force push to `main` is refused |
| Check the container is locked | `npx @devcontainers/cli@0.89.0 exec --workspace-folder . bash`, then `gh auth status` and `git push --dry-run` | Both **fail** |

- **Don't use WebStorm's built-in Dev Containers.** It can forward your Git credentials into the container. `npm run check:linux` uses the Dev Containers CLI.

## Still to do outside the code

- **Discovery calls:** 15 by 2027-01-25 (the problem-fit kill criterion).
- **Secure the name:**
  - the `revisum` GitHub organisation and npm package;
  - `revisum.dev`, `revisum.ai` and `getrevisum.com`;
  - a manual UKIPO and EUIPO search;
  - revisum.com is listed at $2,499. It's optional; wait.
- When the repo goes public at beta, protect `main` (see Setup reference).
- Before the beta, review these:
  - `holdouts.json` (SPEC-02, SPEC-22);
  - how a high-risk review record reaches `main` before the PR result;
  - the "35 browser majors" figure in `E:\core\docs\12-independence-breadth.md`.
