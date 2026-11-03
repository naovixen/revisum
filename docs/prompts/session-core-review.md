# Brief: review of a core refactor part

The founder requires this after every part of grounding the core (2026-11-03). A part isn't ticked in `START.md` until its review is clear.

The main session replaces `<PART>` and `<COMMITS>`, then gives everything below the line, as its whole brief, to a helper agent with a fresh context that didn't write the part. It passes on no notes from the authors.

If findings come back, a code helper fixes them in their own commit, and a new reviewer with a fresh context checks the result. After two rounds, anything still open goes to the founder with a recommendation, rather than round again.

---

Review the core refactor part **<PART>**, commits `<COMMITS>`, as an independent reader. Read the changed code and what calls it, not just the diff. Judge the design as it stands now, even where the code was already like that before this part.

**Check:**

- **Robust at the core.** The core guarantees what it promises, so adapters don't have to make up for it. Flag an adapter or caller that retries, normalises, validates, defaults or guards something the core should settle, and core code that branches on a particular driver, runner or target.
- **Single responsibility.** One reason to change per file and per function. Flag a function that sequences work and also does the detail.
- **Open to extension.** Adding a step or a concern means adding a table entry or a new file the compiler demands, not editing scattered lists and switches.
- **Substitution.** Every implementation of a port, fakes included, honours the same contract, with no special cases for one of them.
- **Narrow ports.** A consumer depends only on what it uses. Flag a wide port that callers only partly use.
- **Dependencies point inward.** The core depends on ports in `contracts`, is handed them, and never builds its own collaborators.
- **Conditionals.** No nested ternaries. Flag a condition the types already rule out, a defensive check for an impossible state, a boolean flag that switches behaviour, and any branching a table or a smaller type would remove.
- **Types.** Illegal states can't be represented: discriminated unions and branded types instead of loose strings and optional fields that depend on each other. No `any`, no unsafe or needless cast, and `unknown` is parsed before use. Exhaustive handling fails to compile when a case is added.
- **Services and factories, used well.**
  - Work with collaborators or state belongs in a factory or service that is handed its ports, such as `createRunService(ports)`.
  - Flag a file that is a bag of loosely related functions passing the same arguments around: that is a missing service, or several files.
  - Pure logic (parser, policy, oracle, secrets) stays as pure functions, with one role per file.
  - Flag a service or factory that wraps one function for no gain, or that has no second implementation or test double to justify the seam. A class hierarchy or DI container is also a finding.
- **Guarantees kept.** Deny by default, only the fill executor receives secrets, decoders report code and path only, a fresh browser per run in production, and the version check. No refactor commit changes a golden.

**Run** `npx eslint` on the changed files with suppressions ignored (`--no-suppressions`, or the current equivalent). Any `no-nested-ternary`, `strict-boolean-expressions`, `no-unnecessary-condition` or `no-unsafe-*` hit in code this part touched is a finding: these don't wait for the later clean-up.

**Report** in at most 40 lines, most serious first. For each finding: file and line, the principle it breaks, what goes wrong in concrete terms (the change that becomes hard, or the input that breaks it), and the smallest fix. Mark each `must fix` or `consider`. Taste alone isn't a finding. End with a verdict: `clear` or `not clear`.

Change no files and don't commit. Don't start other agents. Say "no findings" if there are none.
