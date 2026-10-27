# Brief: code against frozen tests

The main session replaces `<NN>` with the spec number and `<TESTS-COMMIT>` with the tests commit, and gives everything below the line, as its whole brief, to a helper agent with a fresh context. The main session commits the result.

---

Implement **SPEC-<NN>** so the tests committed at `<TESTS-COMMIT>` pass.

**Read:** `CLAUDE.md`, `docs/system-design.md`, `docs/glossary.md`, `docs/specs/SPEC-<NN>-*.md`, and the tests tagged `AC-SPEC-<NN>-*`.

**Do:**
- Write types first, in the spec's "Interfaces and types", in `packages/contracts` or the owning package. Then write the implementation.
- Keep to the dependency direction and the naming rules. Every new name must make sense without reading any spec.
- Parse every external input with a decoder. No `as` casts to branded types outside their parser.
- Write short comments that explain why, in plain English.
- Run `npm run check` until it's green. No retries or skips.

**Don't:**
- change any file in `test/`, `proofs/`, `fixtures/` or `golden/`. If a test looks wrong, stop and explain why with the criterion ID;
- add a runtime dependency to `contracts` or `engine`;
- commit; the main session does that.

**Finish with:**
1. the files changed;
2. each criterion and the test that now passes;
3. the `npm run check` summary;
4. anything in the spec you had to interpret;
5. open questions.
