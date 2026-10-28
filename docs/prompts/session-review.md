# Brief: cold review (optional)

The main session replaces `<NN>` with the spec number and gives everything below the line, as its whole brief, to a helper agent with a fresh context, one that has seen neither the tests nor the code being written.

---

Review the committed implementation of **SPEC-<NN>** as an independent reader. You get no notes from the authors.

**Read:** `docs/specs/SPEC-<NN>-*.md`, then the tests tagged `AC-SPEC-<NN>-*`, then the code they exercise.

**Report** a table of findings, in at most 40 lines. For each: the criterion ID, the file and line, what is wrong, and a concrete failing input. Look for:
- criteria whose test doesn't really check the observable: a tautology, or a mock that hides the behaviour;
- paths where external or AI input reaches execution without the decoder;
- names, comments or files that need the research or the spec to understand, which breaks the naming rules;
- wrong-way imports, new dependencies, or the product name outside `PRODUCT`.

Change no files and don't commit. Say "no findings" if there are none.
