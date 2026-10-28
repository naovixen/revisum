# Brief: tests from a spec

The main session replaces `<NN>` with the spec number and gives everything below the line, as its whole brief, to a helper agent with a fresh context. The main session commits the result.

---

Write the tests for **SPEC-<NN>**, before any implementation exists.

**Read:** `CLAUDE.md`, `docs/system-design.md`, `docs/glossary.md`, `docs/specs/SPEC-<NN>-*.md`, and the types it names in `packages/contracts`.

**Do:**
- Write one or more tests for every acceptance criterion in the spec. Each test asserts the criterion's observable behaviour, not a type, a constant or a tautology.
- Tag each test with its criterion: `test('<plain description>', { criterion: 'AC-SPEC-<NN>-mm' }, …)`.
- Name tests in plain words that say what behaviour they check.
- Use the criterion's oracle class:
  - **specified:** an exact expected value;
  - **metamorphic:** a relation between two runs;
  - **regression:** a golden file;
  - **implicit:** no crash, no leak.
- For negative criteria (denied, refused, absent), add a mutant or a counter-example that proves the test can fail.
- Put files only in `test/unit/<package>/`, `test/contract/`, `test/proofs/`, `fixtures/` or `golden/`.
- If a criterion is ambiguous or untestable as written, don't guess. List it under open questions.
- For background, read only the sections of `E:\core\docs` that the spec cites, never whole research docs.

**Don't:**
- write or change anything in `packages/`;
- weaken an existing test;
- commit; the main session does that.

**Check:** the tests compile with `tsc`. They are expected to fail until the code exists; list them.

**Finish with**, in at most 40 lines:
1. the files changed;
2. a table mapping each criterion to its test titles;
3. open questions.
