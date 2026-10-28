# Contributing

## In short

- Every change starts from a spec in `docs/specs/`. Work from its acceptance criteria and nothing else.
- Tests and code are written by **separate agents with fresh contexts, in separate commits**. Tests are committed first; the code is then written against them, frozen.
- `npm run check` must be green before code is committed. `npm run check:linux` repeats it on CI's pinned Linux image.
- The coding agent may commit. Only the founder pushes and merges. That push is the approval, recorded as `declared`. An AI agent's approval never counts, and nothing waits on a second person.

## The spec template

Copy this for a new spec, as `docs/specs/SPEC-nn-<short-name>.md`:

```markdown
# SPEC-nn: <title>

## Purpose
One paragraph: the user's problem and the outcome this spec delivers.

## Scope and non-goals
- **In:** what this spec builds.
- **Non-goals:** what it explicitly does not.

## Interfaces and types
The TypeScript types, ports and JSON Schema, written and reviewed before any implementation.

## Acceptance criteria
- AC-SPEC-nn-01: When <trigger>, <the system> shall <observable behaviour> (oracle: specified | implicit | metamorphic | regression).

## Dependencies
Other specs, ports and packages this one needs.

## Milestone
M0 to M4, or a later phase.

## Satisfies
The requirement ids this spec meets.
```

Rules for criteria:

- Each criterion has an id, one observable behaviour and an oracle class:
  - **specified:** an exact expected value;
  - **implicit:** no crash, no leak;
  - **metamorphic:** a relation between two runs;
  - **regression:** a golden file.
- Criterion ids never change once merged. They are data: they appear in test metadata, commit trailers and the trace index, never in names.

## The workflow

The founder drives one Claude Code session, which works through the spec queue in `START.md` on its own (`docs/build-loop.md`). It hands the tests and the code to separate helper agents, each starting from a fresh context with only its brief, and commits their work separately.

| Step | Who | What | Allowed to change |
|---|---|---|---|
| 1. Spec | Founder | Writes or approves the spec | `docs/specs/` |
| 2. Types | Code helper | Adds the spec's types and ports, if they are new | `packages/`, `docs/` |
| 3. Tests | Tests helper (`docs/prompts/session-tests.md`) | Writes at least one test per criterion, tagged `{ criterion: 'AC-SPEC-nn-mm' }`. Tests are expected to fail | `test/`, `proofs/`, `fixtures/`, `golden/` only |
| 4. Commit | Main session | Checks the change is tests only, then commits it alone | — |
| 5. Code | Code helper (`docs/prompts/session-code.md`) | Implements the spec until the frozen tests pass. Never edits a test: if one looks wrong, stops and explains | `packages/`, `tools/`, `docs/` only |
| 6. Commit | Main session | Runs `npm run check`, then commits the code | — |
| 7. Push | Founder | Reads the commits, then pushes to `main` | — |

- An optional cold review uses `docs/prompts/session-review.md`, in a third fresh helper.
- The test set is `test/`, `proofs/`, `fixtures/` and `golden/`. No commit may change it together with anything else; this stops a change editing a test to make its own code pass. Check staged files with `git diff --cached --name-only | node tools/check-tests-apart.ts`. CI runs the same check on pull requests.
- `.github/CODEOWNERS` gives the test set and CI configuration to the founder.

## Definition of Done

A spec is done when all of these hold:

1. Every acceptance criterion has at least one test tagged with its id, committed before the code, in its own commit.
2. `npm run check` is green locally and in CI, on the pinned Linux image, with no retries and no skipped tests.
3. The `tests-apart` check passed on the tests commit and on the code commit.
4. No runtime dependency was added to `contracts` or `engine`. Any new third-party package elsewhere has a dependency review in `docs/decisions/`, written before it was added.
5. Generated files are regenerated once they exist: the guarantee table, logging manifest, JSON Schema and changelog.
6. The founder read the commits, including any change to assertions, and pushed them personally. That approval is recorded as `declared`.

## Commands

| Command | Does |
|---|---|
| `npm run check` | Everything below, in order. Must be green before you finish |
| `npm run check:linux` | `npm run check` on CI's pinned Linux image, in Docker. Needs Docker Desktop running |
| `npm run typecheck` | `tsc --build` over every package and `tools/`. A wrong-way import between packages fails here |
| `npm run lint` | Licence map, folder layout, and the trusted-package import check |
| `npm run lint:names` | The naming lint's self-test, then the naming lint over the repository |
| `npm test` | Unit and contract tests (`test/unit/`, `test/contract/`) |
| `npm run proofs` | Hostile plans, secret leaks, egress, PII and audit-chain proofs (`test/proofs/`) |
| `npm run replay` | Golden runs replayed and compared by hash (`test/replay/`) |
| `npm test -w <package>` | Tests for one package, once it has a `test` script |

## Code rules

- **TypeScript on Node 24**, strict, erasable syntax only: no enums, namespaces or parameter properties. Node runs the `.ts` files directly; `tsc` is the type check.
- **Dependency direction.** Every package depends only on `contracts`, except `cli`, which wires the others together, `action`, which wraps `cli`, and `auditor-act`, which reuses `driver-cdp`'s browser connection and launcher. Each package's `tsconfig.json` lists the packages it may import; importing any other fails the build.
- **Outside input is `unknown`** until a hand-written decoder in `engine` parses it. No `as` casts to branded types outside their owning parser.
- **Browsers run headless**, always.
- **Licences.** `licences.json` maps each package to Apache-2.0 or FSL-1.1-ALv2; `npm run lint` checks every `package.json` against it.

## Naming rules

The code must read without any other document.

- Name things after what they are or do, in words a new developer knows: `evaluatePolicy`, `DependencyReview`, `tracedCriteriaShare`.
- No research or process ids in identifiers, file or folder names, JSON keys, error codes or flags.
- No single-letter names except loop indices `i`, `j`, `k` and coordinates `x`, `y`, and never as an export. That includes generic type parameters: write `<Value>`, not `<T>`.
- No unexplained abbreviations. Allowed: id, url, uri, html, css, json, http, api, cli, ci, pr, cdp, bidi, wcag, act, a11y, pii, sha256, svg, png, dom, os. Standard names (ai, mcp, sarif, junit, oidc, jwt, lti) are spelt out in `docs/glossary.md`.
- Comments explain what and why in plain English. You may add "See `docs/specs/SPEC-nn-<name>.md`", but never as the only content.
- The product name is written once, in `PRODUCT` in `packages/contracts/src/product.ts`.
- `docs/glossary.md` maps each domain term to its code name. Add a row when you add a term.
- `npm run lint:names` enforces these rules. Its configuration is `tools/naming-lint-config.ts`.

## Commit trailers

Whoever commits adds these; they feed the project's own metrics:

```
Agent: <tool>/<version>       when an agent wrote the change
Spec: SPEC-nn                 one per spec the commit implements
Criteria: AC-SPEC-nn-mm, AC-SPEC-nn-mm
```
