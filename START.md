# Start here

This repo holds the approved design for Revisum and nothing else yet. Follow the steps in order. Each step has a check, so you know it worked.

**Starting a Claude Code session here:** open a terminal in `E:\revisum`, run `claude`, and say: *"Read START.md and help me with the next unchecked step."* Claude can't run git commit, push, `gh repo` or `gh api` here: you run those yourself.

## Progress

- [x] 1. Research committed in `E:\core`
- [x] 2. Research commit hash filled in
- [ ] 3. Image digest pinned
- [ ] 4. First commit and private GitHub repo
- [ ] 5. `main` protected
- [ ] 6. Dev container open and locked
- [ ] 7. Session 0a: skeleton
- [ ] 8. Session 0b: tests from the spikes
- [ ] 9. Session 0c: code from the spikes
- [ ] 10. Week 1: SPEC-27, then SPEC-01

## Setup

| # | Step | How | Check |
|---|---|---|---|
| 1 | Commit the research | In `E:\core`, run `git add -A` then `git commit -m "Research complete: decision docs, specs, spikes, build templates"` | `git status` is clean |
| 2 | Record the research commit | `git -C E:/core rev-parse --short HEAD`. Put the hash in `CLAUDE.md` under Provenance; Claude can do this for you | No `<research-commit>` left in `CLAUDE.md` |
| 3 | Pin the container image | `docker pull mcr.microsoft.com/devcontainers/typescript-node:24-bookworm`, then `docker inspect --format "{{index .RepoDigests 0}}" mcr.microsoft.com/devcontainers/typescript-node:24-bookworm`. Replace `<pin-at-M0>` in `.devcontainer/devcontainer.json` with the digest | The image line ends in `@sha256:` and 64 hex characters |
| 4 | First commit and GitHub repo | `git add -A`, `git commit -m "Design, specs and setup for Revisum"`, then `gh repo create revisum --private --source=. --remote=origin --push` | The repo shows on GitHub with one commit on `main` |
| 5 | Protect `main` | GitHub → Settings → Rules → new branch ruleset on `main`: require a pull request and block force pushes. After session 0a's first CI run, also require the `ci` and `tests-apart` checks | A direct `git push` to `main` is refused |
| 6 | Open the dev container | VS Code with the Dev Containers extension: "Reopen in Container". Inside, run `claude` and log in | Inside the container, `gh auth status` **fails** and `git push --dry-run` **fails**. If either works, turn off Git credential forwarding before going on |

- **Rules on a private repo need a paid GitHub plan.** On GitHub Free, private repos have no branch rules. Either take GitHub Pro (about $4 a month), or skip step 5 until the repo goes public at beta. The deny rules and the credential-free container still lock the agent out.
- Docker Desktop with WSL 2 must be running for steps 3 and 6.
- Steps 1–5 can run in a session on Windows. From step 7 on, Claude runs **inside** the dev container.

## Build sessions

The prompts live in `docs/prompts/`. Paste each one into a **fresh** session inside the dev container, fill in the placeholders, and commit after each session. Claude never commits.

| Step | Prompt | Fill in | Then you |
|---|---|---|---|
| 7 | `session-00-seed.md` | `<PART>` = 0a, `<COMMIT>` = the research hash | Check that `npm run check` is green; commit; open a PR; merge |
| 8 | `session-00-seed.md` | `<PART>` = 0b | Read the tests; commit them alone; merge |
| 9 | `session-00-seed.md` | `<PART>` = 0c | Read the diff; commit; merge; remove the `/research-spikes` mount |
| 10+ | `session-tests.md`, then `session-code.md` | `<NN>` = the spec number; `<TESTS-COMMIT>` for the code session | Merge the tests first, then the code. The optional `session-review.md` gives a cold review |

**Spec order:** SPEC-00 (session 0), then SPEC-27, SPEC-01, SPEC-02 and onwards, following the milestones in `docs/system-design.md` §7. Keep one spec in flight until M1 is done.

**Track velocity:** record actual days per spec in `docs/decisions/velocity.md`. Check against M1 at week 9.25; the kill criteria are in `E:\core\docs\09-mvp-plan.md`.

## Still to do outside the code

- **Secure the name:**
  - the `revisum` GitHub organisation and npm package;
  - `revisum.dev`, `revisum.ai` and `getrevisum.com`;
  - a manual UKIPO and EUIPO search;
  - revisum.com is listed at $2,499. It's optional; wait.
- Before the beta, review these:
  - `holdouts.json` (SPEC-02, SPEC-22);
  - how a high-risk review record reaches `main` before the PR result;
  - the "35 browser majors" figure in `E:\core\docs\12-independence-breadth.md`.
