# Revisum

Revisum independently verifies AI-built web software. It runs human-approved, typed test plans in real browsers, audits accessibility, and returns evidence: a result file, a visual report, a PR comment and a review queue whose decisions are recorded.

The product name is Revisum (`revisum` for the repo, packages and CLI). It appears in code only in the `PRODUCT` constant, so a rename stays a one-line change.

## Current phase: setup, then session 0

- **No product code exists yet.** `START.md` is the founder's setup checklist and says which session runs next. Keep its "Progress" list up to date.
- The design is approved: `docs/system-design.md` and `docs/specs/` are the source of truth. Don't redesign; raise a question instead.
- **Research repo:** the research behind this design lives in `E:\core` (read-only at `/research-docs` and `/research-spikes` in the dev container). Doc numbers in the specs (`04`, `09`, `13`, …) refer to `E:\core\docs\NN-*.md`. Claim IDs `[C-…]` and `[calc:…]` markers are research references. Read them for background, but never copy them into code. Key ones:
  - `09-mvp-plan.md`: milestones, kill criteria, the 36-week plan;
  - `13-requirements-specs.md`: requirements;
  - `15-build-start.md`: the setup and session workflow.

## Working with the founder

- The founder is a solo, bootstrapped founder working full time. Prefer minimum spend, local-first designs and free tiers.
- **Never gate anything behind a second person.** The founder's own approval (a commit or merge to `main`) is the approval route, recorded as `declared`. An AI agent's approval never counts.
- Write in UK English. Docs are concise and actionable: In short, then Decisions, then Findings, then Risks. No padding.
- Offer every route that fits users' workflows, such as tickets, their own LLM, our UI or our chatbot. All of them parse into one typed plan.

## Read first

- `docs/system-design.md`: packages, run pipeline, folder structure, naming rules.
- `docs/glossary.md` (created in session 0a): domain terms and their code names.
- `docs/specs/SPEC-nn-*.md`: the spec your session works on. Work from its acceptance criteria and nothing else.
- `CONTRIBUTING.md` (created in session 0a): Definition of Done and the session workflow.
- `docs/prompts/`: the session prompts. The founder pastes them; improve them only through a reviewed change.

## Rules

- **You never commit, push, merge, tag or approve.** The founder does all version control. Deny rules and the dev container enforce this; don't look for ways round them.
- **Tests and code are separate sessions.**
  - A tests session changes only `test/`, `fixtures/` and `golden/`.
  - A code session changes only `packages/`, `tools/` and `docs/`, and never a test. If a test looks wrong, stop and say why.
- **Correct by construction.** AI output, and any input from outside, is `unknown` until a hand-written decoder in `engine` parses it. Never let unparsed data reach execution. No `as` casts to branded types outside their owning parser.
- **Dependency direction.** `engine` imports only `contracts` and Node built-ins. Only `cli` wires packages together. A wrong-way import must fail `tsc`; never work round it.
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

## When you finish a session

Reply with:
1. the files changed;
2. the acceptance criteria covered, by ID;
3. the commands run and their results;
4. any open questions or deviations from the spec.

The founder reviews and commits.

## Provenance

Seeded from the research repo `E:\core` at commit `367700e`. `seed-provenance.json` (written in session 0c) lists each seeded file and its source hash. The research itself is not part of this repo.
