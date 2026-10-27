# Session R: cold review (optional)

Paste everything below the line into a fresh Claude Code session that has seen nothing of sessions A and B. Replace `<NN>` with the spec number.

---

Review the merged implementation of **SPEC-<NN>** as an independent reader. You get no notes from the authors.

**Read:** `docs/specs/SPEC-<NN>-*.md`, then the tests tagged `AC-SPEC-<NN>-*`, then the code they exercise.

**Report** a table of findings. For each: the criterion ID, the file and line, what is wrong, and a concrete failing input. Look for:
- criteria whose test doesn't really check the observable: a tautology, or a mock that hides the behaviour;
- paths where external or AI input reaches execution without the decoder;
- names, comments or files that need the research or the spec to understand, which breaks the naming rules;
- wrong-way imports, new dependencies, or the product name outside `PRODUCT`.

Change no files and don't commit. Say "no findings" if there are none.
