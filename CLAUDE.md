# Revisum

Revisum independently verifies AI-built web software. It runs human-approved, typed test plans in real browsers, audits accessibility, and returns evidence: a result file, a visual report, a PR comment and a review queue whose decisions are recorded.

The product name is Revisum (`revisum` for the repo, packages and CLI). It appears in code only in the `PRODUCT` constant, so a rename stays a one-line change.

## Current phase: session 0

- Setup is done. `START.md` is the founder's checklist and says which step runs next. Keep its "Progress" list up to date.
- The design is approved: `docs/system-design.md` and `docs/specs/` are the source of truth. Don't redesign; raise a question instead.
- **Research repo:** the research behind this design lives in `E:\core`. Treat it as read-only. Doc numbers in the specs (`04`, `09`, `13`, …) refer to `E:\core\docs\NN-*.md`. Claim IDs `[C-…]` and `[calc:…]` markers are research references. Read them for background, but never copy them into code. Key ones:
  - `09-mvp-plan.md`: milestones, kill criteria, the 36-week plan;
  - `13-requirements-specs.md`: requirements;
  - `15-build-start.md`: the setup and session workflow.

## Working with the founder

- The founder is a solo, bootstrapped founder working full time. Prefer minimum spend, local-first designs and free tiers.
- **Never gate anything behind a second person.** The founder's own approval (a push or merge to `main`) is the approval route, recorded as `declared`. An AI agent's approval never counts.
- The founder works in one Claude session on Windows, in WebStorm's terminal. Don't ask them to manage other sessions, containers or prompts.
- Write in UK English. Docs are concise and actionable: In short, then Decisions, then Findings, then Risks. No padding.
- Offer every route that fits users' workflows, such as tickets, their own LLM, our UI or our chatbot. All of them parse into one typed plan.

## Read first

- `docs/system-design.md`: packages, run pipeline, folder structure, naming rules.
- `docs/glossary.md` (created in session 0a): domain terms and their code names.
- `docs/specs/SPEC-nn-*.md`: the spec your session works on. Work from its acceptance criteria and nothing else.
- `CONTRIBUTING.md` (created in session 0a): Definition of Done and the session workflow.
- `docs/prompts/`: the briefs you give helper agents. Change them only when the founder agrees.

## How a spec is built

One session runs the whole loop. See `docs/decisions/single-session-workflow.md` for why.

1. **Tests.** Start a helper agent with a fresh context. Give it `docs/prompts/session-tests.md`, with `<NN>` filled in, as its whole brief. Check that it changed only the test set: `test/`, `proofs/`, `fixtures/` and `golden/`. Then commit the tests alone.
2. **Code.** Start a second fresh helper with `docs/prompts/session-code.md`, with `<NN>` and `<TESTS-COMMIT>` filled in. It changes only `packages/`, `tools/` and `docs/`, never a test. If it says a test looks wrong, stop and take that to the founder; never fix the test yourself. When `npm run check` is green, commit the code.
3. **Review (optional).** A third fresh helper with `docs/prompts/session-review.md` reports findings and changes nothing.
4. **Report** to the founder (see "When you finish" below). The founder reviews and pushes.

Write your own changes (docs, START.md, small fixes) as separate commits too, never mixed with test-set files.

## Rules

- **You commit; the founder pushes.**
  - Commit each finished, checked step yourself, on `main`, with the trailers in `CONTRIBUTING.md`.
  - Never push, merge, rebase, tag, amend a commit, skip hooks or approve anything. The founder's push to `main` is the approval.
  - Deny rules in `.claude/settings.json` enforce this. Don't look for ways round them, such as a script that pushes.
- **Tests and code are separate helpers and separate commits.**
  - The test set is `test/`, `proofs/`, `fixtures/` and `golden/`. A tests commit changes only the test set.
  - A code commit changes only `packages/`, `tools/` and `docs/`, and never the test set.
  - Before each commit, run `git diff --cached --name-only | node tools/check-tests-apart.ts`. It must pass.
- **Correct by construction.** AI output, and any input from outside, is `unknown` until a hand-written decoder in `engine` parses it. Never let unparsed data reach execution. No `as` casts to branded types outside their owning parser.
- **Dependency direction.** `engine` imports only `contracts` and Node built-ins. Only `cli` wires packages together; the one other cross-package import is `auditor-act` using `driver-cdp`'s browser connection. A wrong-way import must fail `tsc`; never work round it.
- **No new runtime dependency** in `contracts` or `engine`. Any third-party package elsewhere needs a dependency review in `docs/decisions/` first.
- **TypeScript:** strict, erasable syntax only (no enums, no namespaces, no parameter properties). Run on Node 24.
- **Browsers run headless**, always.
- Never kill processes you didn't start.

## Naming: the code must read without any other document

- Name things after what they are or do, in words a new developer knows: `evaluatePolicy`, `DependencyReview`, `tracedCriteriaShare`.
- Never use research or process IDs in identifiers, file or folder names, JSON keys, error codes or flags. Banned:
  - R1–R13, RC-, FR-, NFR-, UP-, SC-, FD-, H1–H18;
  - P1–P7 and p3–p7;
  - claim IDs and doc numbers.
- No single-letter names, except loop indices and x/y. No unexplained abbreviations.
  - Allowed: id, url, uri, html, css, json, http, api, cli, ci, pr, cdp, bidi, wcag, act, a11y, pii, sha256, svg, png, dom, os.
  - Standard names, each spelled out in `docs/glossary.md`: ai, mcp, sarif, junit, oidc, jwt, lti.
- Comments explain what and why in plain English. You may add "See docs/specs/SPEC-nn-….md", but never as the only explanation.
- Criterion IDs are data, never names:
  - `test('rejects unknown steps', { criterion: 'AC-SPEC-01-03' }, …)`.
- `npm run lint:names` must pass.

## Commands (from session 0a on)

| Command | Does |
|---|---|
| `npm run check` | `tsc`, lint, naming lint, unit and contract tests, proofs, replay. It must be green before you finish |
| `npm test -w <package>` | Tests for one package |
| `npm run proofs` | Hostile plans, secret leaks, egress, PII, audit chain |
| `npm run replay` | Golden runs, compared by hash |
| `npm run check:linux` | `npm run check` on CI's pinned Linux image, in Docker. Run it before reporting a step done when screenshots, fonts or replay hashes are involved |

## When you finish

Reply with:
1. the commits made, with their hashes, and the files each changed;
2. the acceptance criteria covered, by ID;
3. the commands run and their results;
4. any open questions or deviations from the spec.

The founder reviews and pushes.

## Provenance

Seeded from the research repo `E:\core`. `seed-provenance.json` records the research commit and each seeded file's source hash; it is the only file that names that commit. The research itself is not part of this repo.
