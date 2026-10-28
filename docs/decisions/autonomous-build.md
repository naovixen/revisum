# The build runs on its own between milestone exits

Founder decision, 2026-10-28.

## In short

- The main session works through the spec queue in `START.md` without stopping, following `docs/build-loop.md`.
- It answers questions from this repo, then the research repo, then the web, and logs each answer in `docs/decisions/answers.md`. It stops only for the listed reasons, or at a milestone exit.
- The workflow is shaped to keep context and tokens small: helpers do the reading, reports are capped at 40 lines, and state lives in files.

## Decisions

| Was | Now | Why |
|---|---|---|
| The founder started each spec | *"Continue the build"* runs the queue | Fewer hand-offs; the founder's time goes to answers and reviews |
| Questions went to the founder | Repo, then research, then web, then the founder | Most questions are answered in the research already |
| The loop lived in `CLAUDE.md` | `docs/build-loop.md`, read by the main session only | Every helper loads `CLAUDE.md`; keeping the loop out of it saves tokens on every helper |
| An optional review per spec | Reviews at milestone exits, for trust-path specs only | Reviews cost a full read of the code; they matter most where trust is decided |
| Push after each session | Push at each milestone exit, or any time | The founder reviews a milestone's commits together |

## Risks

- **Answers without the founder.** The session may answer a question differently from the founder. Mitigation: every answer is a row in `docs/decisions/answers.md` with its source, and anything that changes scope, cost, security, licences or a committed test still stops the build.
- **Unpushed work piles up.** A milestone can mean many local commits, and CI runs only on push. Mitigation: `npm run check:linux` for browser-related specs, and the founder can push at any time.
- **Long sessions lose detail.** Mitigation: a fresh session per milestone, resuming from `START.md`.
