# One session on Windows; the agent commits, the founder pushes

Founder decision, 2026-10-27.

## In short

- The founder drives one Claude Code session on Windows, in WebStorm's terminal. There's no dev container to start and no prompts to paste.
- The session hands tests and code to separate helper agents with fresh contexts, and commits their work in separate commits.
- The agent may commit. Only the founder pushes. The push is the approval, recorded as `declared`.
- The pinned Linux image stays: CI uses it, and `npm run check:linux` runs the same check locally.

## Decisions

| Was | Now | Why |
|---|---|---|
| Each session ran in the dev container, started and pasted by hand | One session on Windows | Managing two kinds of session, a container and prompts slowed every spec down |
| Only the founder committed | The agent commits each checked step; it can't push, merge, rebase, tag, amend or skip hooks | Committing every step by hand was the main cost. The push is still a human step, so the approval is still the founder's |
| Tests and code in separate sessions | Tests and code in separate helper agents, each with a fresh context, and separate commits | Keeps the code writer from seeing or steering the tests, without a second session to manage |
| The tests-apart check on pull requests only | The same check run on staged files before every commit | Commits go straight to `main`, so the pull-request check never runs |
| One `node_modules`, installed in Linux | Windows and the container each have their own; the container's is a Docker volume | TypeScript 7 installs a different binary per operating system |

Removed: `tools/session.ps1`, `tools/session-start.sh` and the WebStorm buttons in `.run/`.

## Findings

- With `node_modules` installed on Windows, `npm run typecheck` and `npm run lint` pass on Windows.
- Unit, contract, proof and replay tests fail on Windows only because the code doesn't exist yet: every failure is a missing export that session 0c adds.
- The naming lint reports 5,831 problems, all in the test set seeded by session 0b: it reads hex hashes in golden files as research ids. This is a lint bug for session 0c to fix in `tools/`. The test set must not change.

## Risks

- **The agent has no Git isolation.** On Windows it runs beside the founder's Git login. Only the deny rules stop a push, and `main` has no branch protection on GitHub Free, so a push that got past them would land directly. A script the agent writes could, for example, call `git push`. Mitigation: the rules in `CLAUDE.md`, the deny rules, and the founder reading `git log` before each push. When the repo goes public at beta, protect `main` (START.md step 5).
- **Windows and CI can differ.** Screenshots, fonts and replay hashes may not match the Linux image. Run `npm run check:linux` before pushing anything with screenshots or replay, and read CI after each push.
- **Separation is weaker than separate sessions.** The same main session briefs both helpers. Separate commits and the per-commit check keep the boundary visible in history.
- **SPEC-02's agent lock-down, resolved.** The product's lock-down route required the agent to be denied commits and to hold no GitHub credentials, which Revisum's own build no longer met. Founder decision, 2026-10-27: the route now requires push, merge and pull-request approval to be denied, and commits may be allowed, because the push is the approval. Whether the agent's environment holds credentials is declared and recorded, not required, since core can't check it either way. Approvals on this route stay labelled `declared`.
