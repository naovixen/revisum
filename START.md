# Start here

The founder's checklist. Follow the steps in order. Each step has a check, so you know it worked.

**How you work:** open WebStorm's terminal in `E:\revisum`, run `claude`, and say *"Read START.md and do the next unchecked step."* That one session does the work and commits it. You read the commits and push. Claude can't push, merge, rebase or tag. See `docs/decisions/single-session-workflow.md`.

## Progress

- [x] 1. Research committed in `E:\core`
- [x] 2. Research commit hash filled in
- [x] 3. Image digest pinned
- [x] 4. First commit and private GitHub repo
- [x] 5. `main` protection: skipped on GitHub Free until the repo goes public at beta
- [x] 6. Dev container locked (now used only for CI and `npm run check:linux`)
- [x] 7. Session 0a: skeleton
- [x] 8. Session 0b: tests from the spikes
- [x] 9. Session 0c: code from the spikes
- [ ] 10. Week 1: SPEC-27, then SPEC-01
- [ ] 11. SPEC-00's remaining criteria (04, 07, 09, 10, 16, 19, 20, and finishing 05, 08, 11, 15, 17): a tests-then-code round

## Setup (done)

| # | Step | How | Check |
|---|---|---|---|
| 1 | Commit the research | In `E:\core`, run `git add -A` then `git commit -m "Research complete: decision docs, specs, spikes, build templates"` | `git status` is clean |
| 2 | Record the research commit | `git -C E:/core rev-parse --short HEAD`. Put the hash in `CLAUDE.md` under Provenance | No `<research-commit>` left in `CLAUDE.md` |
| 3 | Pin the container image | `docker pull`, then `docker inspect --format "{{index .RepoDigests 0}}"` on `mcr.microsoft.com/devcontainers/typescript-node:24-bookworm`. Put the digest in `.devcontainer/devcontainer.json` | The image line ends in `@sha256:` and 64 hex characters |
| 4 | First commit and GitHub repo | `gh repo create revisum --private --source=. --remote=origin --push` | The repo shows on GitHub |
| 5 | Protect `main` | GitHub → Settings → Rules → new branch ruleset on `main`: block force pushes, and require the `ci` check | A force push to `main` is refused |
| 6 | Lock the container | `npx @devcontainers/cli@0.89.0 exec --workspace-folder . bash`, then `gh auth status` and `git push --dry-run` | Both **fail** |

- **Rules on a private repo need a paid GitHub plan.** On GitHub Free, private repos have no branch rules, so step 5 waits until the repo goes public at beta.
- **Don't use WebStorm's built-in Dev Containers.** It can forward your Git credentials into the container. Use `npm run check:linux`, which uses the Dev Containers CLI.

## Building

Tell the session what to build, for example *"Do session 0c"* or *"Build SPEC-27"*. It follows "How a spec is built" in `CLAUDE.md`:

1. A helper agent with a fresh context writes the tests. The session checks they are tests only and commits them.
2. A second fresh helper writes the code against those tests. The session runs `npm run check` and commits the code.
3. Optionally, a third fresh helper does a cold review.
4. The session reports the commits. You read them (`git log -p`, or WebStorm's Git log) and push.

| Step | What to say | Note |
|---|---|---|
| 9 | "Do session 0c" | The naming lint currently flags hashes in the 0b golden files; 0c fixes the lint, not the files |
| 10+ | "Build SPEC-nn" | One spec at a time |

- **Before you push** anything with screenshots, fonts or replay hashes, ask for `npm run check:linux` (Docker Desktop must be running). It runs the check on CI's Linux image.
- **After each push,** check that CI is green on GitHub.

**Spec order:** SPEC-00 (session 0), then SPEC-27, SPEC-01, SPEC-02 and onwards, following the milestones in `docs/system-design.md` §7. Keep one spec in flight until M1 is done.

**Track velocity:** record actual days per spec in `docs/decisions/velocity.md`. Check against M1 at week 9.25; the kill criteria are in `E:\core\docs\09-mvp-plan.md`.

## Still to do outside the code

- **Secure the name:**
  - the `revisum` GitHub organisation and npm package;
  - `revisum.dev`, `revisum.ai` and `getrevisum.com`;
  - a manual UKIPO and EUIPO search;
  - revisum.com is listed at $2,499. It's optional; wait.
- When the repo goes public at beta, do step 5: protect `main`.
- Before the beta, review these:
  - `holdouts.json` (SPEC-02, SPEC-22);
  - how a high-risk review record reaches `main` before the PR result;
  - the "35 browser majors" figure in `E:\core\docs\12-independence-breadth.md`.
