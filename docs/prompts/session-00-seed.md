# Session 0: seed the product repo

Paste everything below the line into a fresh Claude Code session inside the dev container. Before pasting, replace `<PART>` with 0a, 0b or 0c and `<COMMIT>` with the research commit hash. Run the parts in order, with a founder commit after each.

---

You are seeding the product repository for Revisum. It's a tool that independently verifies AI-built web software: it runs human-approved typed test plans in browsers, audits accessibility, and produces evidence. This session does **part <PART>** of SPEC-00.

**Read first, in this order:** `CLAUDE.md`, `docs/system-design.md` (packages, folder structure, naming rules), `docs/glossary.md`, `docs/specs/SPEC-00-repo-seed-and-gates.md`, and `docs/specs/SPEC-27-shared-types-and-events.md`.

**The research spikes** are mounted read-only at `/research-spikes` (research commit `<COMMIT>`). They're prototypes: take their logic and tests, not their names or layout.

## Part 0a: skeleton (no spike code)

- Create the folder tree from `docs/system-design.md` §5 exactly:
  - root `package.json` with npm workspaces and scripts `check`, `test`, `lint`, `lint:names`, `proofs`, `replay`;
  - `tsconfig.base.json`: strict, `erasableSyntaxOnly`, `verbatimModuleSyntax`, project references;
  - one package skeleton per row of §3, each with `src/index.ts`, `package.json`, `tsconfig.json` and a README of 3 to 5 lines.
- Make wrong-way imports a compile error: `engine` references only `contracts`, and only `cli` references the other packages.
- Add the licence files and `licences.json` mapping each package to Apache-2.0 or FSL-1.1, as in §3. Add a CI check that each package's `license` field matches.
- `CONTRIBUTING.md`: the spec template, the Definition of Done and the two-session workflow from the system design. Write it so it stands on its own.
- `.github/CODEOWNERS` covering `test/`, `fixtures/`, `golden/` and `.github/`.
- `.github/workflows/ci.yml`:
  - Linux, the pinned image digest from `.devcontainer/devcontainer.json`, Node 24;
  - jobs `ci` (runs `npm run check`) and `tests-apart` (fails if a PR changes both test-set paths and other paths).
- `tools/lint-names.ts`, the naming lint from SPEC-00. It fails on:
  - banned research-ID patterns in identifiers, file and folder names;
  - single-letter exported names;
  - research-doc citations in comments.

  Prove it with a self-test that plants `R11Test` and expects a failure.
- `docs/glossary.md` with the term-to-code-name table from the system design.
- The `PRODUCT` constant in `contracts`. It's the only place the name appears.

**Exit:** `npm run check` passes, and the naming lint self-test fails on the planted name as expected.

## Part 0b: tests from the spikes (tests only)

- Copy into `test/contract/`, `test/proofs/`, `test/unit/`, `fixtures/` and `golden/`:
  - the P3 contract suite and proofs;
  - the P4 contract suite;
  - the P5 ACT re-score and its fixtures;
  - the P6 golden report.
- Rename every identifier, file and test title to the naming rules. Keep assertions and expected values byte-identical.
- Tag each test with its acceptance criterion where SPEC-00 names one: `{ criterion: 'AC-SPEC-00-01' }`.
- Change nothing outside the test-set folders.

**Exit:** the suites compile against the 0a skeleton. They are expected to fail until 0c; list which ones fail and why.

## Part 0c: code from the spikes (code only)

- Move the spike logic into packages:
  - P3 `src/core` → `engine`;
  - P4 `src/drivers/cdp` and `shared` → `driver-cdp`;
  - P3 `src/adapters/playwright` → `driver-playwright`;
  - P3 `src/adapters/shared/axe.ts` → `auditor-axe`;
  - P5 `src` → `auditor-act`, using `driver-cdp`'s client and not its own;
  - P6 `src/render` and `src/model` → `report`;
  - P7 core types → `contracts`, aligned to SPEC-27.
- Rename everything to the naming rules and the glossary.
- Rewrite comments that cite research documents or spike names into plain explanations.
- Write `seed-provenance.json`: for each seeded file, the source path, the source SHA-256 and the research commit.
- Don't change any file in the test set. If a test can't pass without a change, stop and explain.

**Exit:** SPEC-00 AC-01 to the last SPEC-00 criterion pass, and `npm run check` is green.

## Every part

- Never commit, push or merge; the founder does that.
- Browsers run headless.
- Add no new runtime dependency to `contracts` or `engine`.
- Finish with:
  1. the files created or changed;
  2. the criteria covered;
  3. the commands run and their output summary;
  4. open questions.
