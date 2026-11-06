# Start here

The founder's checklist and the build queue.

**How you work:** open WebStorm's terminal in `E:\revisum`, run `claude`, and say *"Continue the build."* The session builds the next unchecked specs in order, committing each step, until it needs your answer or reaches a milestone exit. Answer its question, or at a milestone exit read the commits, push, check CI is green, and start a fresh session with the same words. Claude can't push, merge, rebase or tag. How it works: `docs/build-loop.md`.

## Progress

**Spec work is paused for the architecture refactor (approved 2026-11-02).** On "Continue the build", take the next unchecked phase here. Spec work resumes after phase 5. Bugs found on the way go in `docs/decisions/refactor-defects.md`.

**The refactor is on the branch `refactor/architecture`, not `main` (founder, 2026-11-02),** so it can be dropped if needed. Commit there. The founder pushes the branch to run CI, and merging it to `main` is the approval. The last commit before the refactor is `5a18cbf`.

Architecture refactor:

- [x] Phase 0: measure the baseline and set the written conventions (`docs/decisions/refactor-baseline.md`)
- [x] Phase 1: cut, reset the goldens once, then freeze them
- [x] Phase 2: fast tests
- [ ] Phase 3: cold bug review, fixes, then ground the core; the founder pushes and CI takes 10 minutes or less (moved from phase 2, founder, 2026-11-02)
  - [x] Cold reviews and the trust-path break test (21 of 24 breaks caught)
  - [x] First round of fixes: false passes, action guard, approval, secrets, parser, evidence mode
  - [x] Run `npm run check:linux` on a new container with `xclip`: green in 36 minutes, with the browser tests serial (24 minutes; CI splits them into 3). The clipboard proof and the symlinked report test ran and passed (findings 25, 99)
  - [x] Confirm host-user deletion of container-owned `test-results`: it fails for a host user with another uid (finding 140)
  - [x] Clear the remaining open findings: nothing open but the deferred rows 159, 161, 163, 165 and 167
  - [x] Before grounding the core: a fresh Opus helper assesses the decisions independently, with `docs/prompts/session-decision-assessment.md`, and the founder rules on what it raises (founder, 2026-11-03). Rulings: `docs/decisions/decision-assessment.md`
  - [ ] Ground the core. The plan is `C:\Users\naomi\.claude\plans\before-starting-on-the-jiggly-squirrel.md`. **Tick a part only when its review with `docs/prompts/session-core-review.md` is clear (founder, 2026-11-03).** Code a part touches leaves with no suppressed nested ternaries, loose conditions or unsafe types; these don't wait for phase 6.
    - **Reviews don't pause the work (founder, 2026-11-04):** after a part's second review, fix what it found, record it and tick as an exception, with no third review and no ruling asked. Only what is truly the founder's to decide stops the work.
    - **Way of working, unless the founder objects:** the core spine runs in order, with at most two side tracks beside it in their own worktrees, applied as patches because the main session can't merge. Not yet run for all this: the full browser suite, `check:push`, `check:linux`, and the container tests beyond `container-hardening`.
    - [x] Switch on `@typescript-eslint/no-unnecessary-condition`, fixing the hits in their own commits, with no baseline. The rule is on at `8efce5f` with no hits (240, not the 22 first counted). Ticked as an exception the founder recorded (2026-11-04, `docs/decisions/decision-assessment.md`), with no `clear` verdict: 180, 181, 187, 189, 190 and 191 are fixed. These are requirements of the driver port, which can't clear without them: 176, 177, 178, 182, 183, 185, 186 (a reproduced false pass), 188 and 192. 184 goes with split `run`.
    - [x] Constant objects in `contracts`. Ticked as an exception the founder recorded (2026-11-04, `docs/decisions/decision-assessment.md`), with no `clear` verdict: 194 and 195 are fixed. 193 and 196 go to the phase 4 sweep, and 197 to the phase 5 docs.
    - [x] Foundation helpers. Two reviews, the second `not clear`; its findings are fixed under the founder's rule that reviews don't pause the work (`ada0438`), with no third review. 198 goes to the `RunResult` part, 199 to step tables and 200 to split `plan-parser`.
    - [x] One complete fake per port, and `fakePorts(overrides)` for the whole set. Two reviews, the second `not clear`; its findings are fixed under the founder's rule that reviews don't pause the work, with no third review. The same 54 tests now run over the fake session and the real driver. `npm run proofs` holds 718 tests in two summary blocks, 494 and 224.
    - [x] Driver port, with findings 14 and 59. Two reviews, the second `not clear`. Its findings are fixed under the founder's rule that reviews don't pause the work (`7cf4d7f`, `dbb2648`, `f75ca15`), with no third review. One finding, row 236, was rejected as not a bug. Carried forward: 213 goes to the cleared run, 220, 221, 240 and 241 to split `cdp-driver`, and 204 waits for the founder. Browser suite at `f75ca15`: 1384 pass, 0 fail, 46 skip.
    - [x] Cleared run, with the pipeline and preflight: the gate returns one value holding plan, project, target and standing; `baseUrl` is parsed; `act` and `probe` take resolved types, with the secret carried on the fill; the guarantee level is read at seal through a port. Two reviews, the second `not clear`; its findings are fixed under the founder's rule that reviews don't pause the work (`be75695`, `a3b6cdf`), with no third review. Rows 213, 242, 243 and 246 to 261 are fixed. Carried forward: 244 (a base URL outside the project's origins) to preflight with the step tables, 245 (`Authorised` redundant) to the phase 4 sweep, and 262 (an unreachable crawl refusal) to the composition root.
    - [ ] Step tables
    - [ ] Split `run`
    - [ ] `RunResult` to contracts, as a union with the same bytes, with findings 8 and 22
    - [ ] Split `plan-parser`, adopting `readFields` as it goes
    - [ ] Cycle rule and in-page free-variable rule
    - [ ] Split `cdp-driver`
    - [ ] Split `egress-proxy`
    - [ ] The runners' shared lifecycle
    - [ ] One composition root: finish `cli/src/BuildAdapters.ts`, so no caller can open a browser without the egress proxy
    - [ ] Throwaway-step experiment: about 7 edits, each forced by the compiler
    - [ ] Re-run the trust-path break test; a break that goes uncaught becomes a finding to fix
- [ ] Phase 4: move files, constants for magic strings, formatting
- [ ] Phase 5: docs and final trust-path review; the founder pushes
- [ ] Phase 6: test titles and remaining suppressions (may run alongside M3)

Where phase 3 stands, from `docs/decisions/refactor-defects.md`:

- **Fix next:** nothing open. Findings 147 and the rest of 148 go with the parts that touch them.
- **Checked at the end (2026-11-03):** `npm run check:linux` green at `ad2946a`, the whole chain. Windows `test:browser` and `check:containers` ran before the last changes: 907 of 953 passed with 46 skipped, and 165 of 170 with one file fixed and passing alone. **Next:** the founder reads the deferred rows, then grounding the core starts.
- **With SPEC-16:** 100-103, 107-112, the rest of 114, 115, 136, and re-reading the guarantee level after a plan run. Founder decided 103: mount tracked files only.
- **Founder decided, still to build:** one real Playwright Test run in the weekly tier, after a dependency review (116).
- **Founder decided:** closed shadow roots stay a documented limit, to revisit with SPEC-10 (129).
- **Founder decided, being built:** host runs always go through a per-session egress proxy set on the browser context, with WebRTC UDP off, stay labelled `host` and claim nothing new (39, 47, 49, 141, 142). The design and commit order are in `docs/decisions/host-egress-proxy.md`. All steps are done.
- **Calls made in the main session, which the founder can reverse:** refused connections in request counts (87, amended in SPEC-33) and allowing U+200C and U+200D in plan text (122).
- **Machine leftovers:** a locked worktree in `.claude/worktrees/` from the break test. Leave it unless the founder says otherwise. `npm run check:linux` uses its own container, labelled `revisum.check=linux`.

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
- [x] SPEC-30 plan values, positions and keys: parser and engine parts; owns plan language 1.2
- [x] SPEC-31 page states, metadata, downloads and tabs: parser parts
- [x] SPEC-32 declared service calls: declarations and request building, against a fake caller
- [x] SPEC-33 network stubs, request checks and storage: grammar
- [x] SPEC-34 clock advance and clipboard checks: parser parts
- [x] Re-run the coverage study on plan 1.2, plus a fresh sample of at least 50, before 2026-11-23: 45% overall, 36% fresh; not met. Founder chose evidence mode with opt-in unsafe features (`docs/decisions/language-fit-pivot.md`)
- [x] SPEC-28 plan authoring (readable format, conversion, `admitDraft`, provenance)
- [x] SPEC-35 evidence mode: declaration, suite-file trust, report decoder, result mapping and labels (no containers)
- [x] SPEC-36 unsafe plan features: plan 1.3 parser parts, declarations, gate rules and labels
- [x] Readable text forms for plan 1.3's unsafe constructs (SPEC-28 addition)
- [x] Measure coverage on plan 1.3 with unsafe features, with parsed plans and strict judging: 52% overall, 44% fresh (2026-10-29)
- [x] SPEC-00 remaining criteria (04, 07, 09, 10, 16, 19, 20; finish 05, 08, 11, 15, 17)
- [x] Fix the intermittent browser failures: Chromium's Windows port randomisation refused about 1 local connection in 60; disabled in both launchers, and browser test files run one at a time (2026-10-28)
- [x] Add a contract test that Chromium's effective feature list disables port randomisation and keeps Playwright's defaults
- [x] M1 exit (2026-10-29): `docs/decisions/milestone-exits.md`

M2, driver and isolation (alpha):

- [x] SPEC-05 target matrix and lock
- [x] SPEC-06 CDP driver, with SPEC-03's guard wired in
- [x] SPEC-07 isolated runner and egress
- [x] SPEC-35 workload runner: suite run, egress, traces and manifest; zero-test suites end Failed, expected failures raise a review item
- [x] SPEC-28 `draft` (route c), with SPEC-37's planner adapters (2026-10-31); moved from M4 (founder, 2026-10-29: `docs/decisions/drafting-earlier.md`)
- [x] SPEC-37 explore to draft: `draft --explore`, crawl, page map, locator check (2026-11-01)
- [x] SPEC-30 to 34 and SPEC-36 driver and runner parts (done 2026-10-31: states, downloads, tab, real service caller, stubs, storage, clock, clipboard, CSS, XPath, DOM checks, page scripts, database commands; replay of database commands comes with SPEC-08)
- [x] SPEC-08 manifest and replay, with SPEC-32's call replay and SPEC-36's database-command replay (AC-SPEC-32-13, AC-SPEC-36-15; 2026-11-01)
- [x] M2 exit (2026-11-01): `docs/decisions/milestone-exits.md`

M3, evidence:

- [ ] SPEC-09 privacy masking
- [ ] SPEC-10 accessibility audit
- [ ] SPEC-29 WCAG test base
- [ ] SPEC-11 result model and exporters
- [ ] SPEC-12 visual report and PR comment
- [ ] SPEC-13 review queue and recorder
- [ ] SPEC-35 snapshot audit, masked captures, report, PR comment and review queue; SPEC-36 labels in exporters
- [ ] SPEC-14 audit log and traceability
- [ ] SPEC-15 metrics panel
- [ ] M3 exit

M4, launch (beta):

- [ ] SPEC-16 CLI and GitHub Action, with SPEC-35's `run --suite` and Action input, writing SPEC-08's opt-in recording file from `run`, and the items carried from the M2 exit (AC-SPEC-16-11 to 13)
- [ ] SPEC-17 release artefacts and claims (marketing render target and claim lint), with SPEC-36's `doctor` checks and claim wording
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

- **Language fit: resolved, does not stop the build.** The share stays under 70% (36% fresh on 1.2). On 2026-10-29 the founder recorded evidence mode with opt-in unsafe features (`docs/decisions/language-fit-pivot.md`) as this signal's response, the one the MVP plan lists. The build goes on until it is demoable, so the founder can judge from use whether the product is worthwhile.
- **Problem fit: set aside, does not stop the build.** On 2026-11-01 the founder said not to worry about discovery calls for now: the aim is a demo, to see it working and judge whether it is feasible.

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
