# Brief: review of a core refactor part

The founder requires this after every part of grounding the core (2026-11-03). A part isn't ticked in `START.md` until its review is clear.

The main session replaces `<PART>` and `<COMMITS>`, then gives everything below the line, as its whole brief, to a helper agent with a fresh context that didn't write the part. It passes on no notes from the authors.

If the verdict is `not clear`, a code helper fixes the `must fix` findings, and any `consider` ones the main session accepts, in a commit of their own. A new entry on `REVEAL_ALLOWED_MODULES` is the exception: it goes straight to the founder. A new reviewer with a fresh context then reviews the part again, that commit included. After two rounds, anything still open goes to the founder with a recommendation, rather than going round again.

This review is the oracle: never remove or relax a requirement because existing code fails it, because the code is what gets fixed (founder, 2026-11-03). To avoid going in circles, do each fix on its own. Anything else found goes under the check it belongs to, not into the fix in hand.

---

Review the core refactor part **<PART>**, commits `<COMMITS>`, as an independent reader. Read the changed code, everything that calls it, and the ports and types it uses, not just the diff. Treat commit messages as claims to check. Judge the design as it stands now, even where the code was already like that before this part.

**What the refactor is for.** The code grew by adding conditionals until particular tests passed, so special cases are spread through the core and the code that uses it, and many files are bags of loosely related functions. Grounding the core moves each of those decisions into the core, made once, behind types that say exactly what it accepts and what it returns. When a part is done, for the code it covers:

- A call that type-checks is a correct call: a caller can't pass anything the core can't handle.
- The core has a defined outcome for every value its types allow, and its return type names every outcome, failures included.
- Code that uses the core needs no branch, check or default of its own to make the core behave. It only handles the outcomes it gets back.
- Nothing is retried, anywhere. The core works first time, or the run ends with an outcome that says what failed.

The test for each part: could someone add a new adapter or caller from the ports, the core's exported types and their doc comments alone, without reading the core's code or copying a workaround from existing code, and have it work first time? Wherever the answer is no, there's a finding.

In this brief, an adapter is anything that implements a port in `contracts`, fakes included, and a caller is anything that uses the core, tests included.

**Check the main goal first:**

- **Callers don't compensate.** Trace every caller of what this part changed. Each of these is fixed in the core, or in a wrapper around a port, never in the caller. Flag a caller that:
  - validates, normalises, defaults or guards something the core should settle, or now already does;
  - catches an exception, or probes the result, to find out what happened, because the return type doesn't say;
  - casts, or uses `!`, on what the core returns;
  - has to call things in a set order (set up, use, clean up) that the core could enforce;
  - repeats a workaround that another caller also has.
- **Total core.** Flag a value the types accept that makes the core throw, hang or return something half-built, and a precondition that lives in a comment or a caller rather than in a type.
- **Parse at the edge.** Input from outside the program is typed `unknown` and parsed once, where it enters, into the precise type the core needs. Nothing downstream checks it again. A function that needs checked or normalised input says so in its parameter type, such as a branded type only the parser can make.
- **No special cases.** Flag a branch that tests for one particular value, such as a check for one origin, locator, fixture or test, where a rule should hold for every input of that type. Flag core code that branches on a particular driver, runner or target. These are mostly left over from getting one test to pass. The fix is the general rule the special case is an instance of, or a type that tells the cases apart, never another branch.

**Then the types and conditionals that make it hold:**

- **Types.** Illegal states can't be represented: discriminated unions and branded types instead of loose strings and optional fields that depend on each other. No `any`, no unsafe or needless cast or `!`, and `unknown` is parsed before use. Exhaustive handling fails to compile when a case is added.
- **Conditionals.** They're fine where they make a real decision: parsing input at the edge, a policy rule, one exhaustive `switch` over a union. Elsewhere, flag a nested ternary, a condition the types already rule out, a defensive check for an impossible state, a boolean flag that switches behaviour, and any branching a table or a smaller type would remove.

**Then the structure:**

- **Single responsibility.** One reason to change per file and per function. Flag a function that sequences work and also does the detail.
- **Open to extension.** Adding a step or a concern means adding a table entry or a new file the compiler demands, not editing scattered lists and switches. Flag two lists or switches that have to be kept in step by hand.
- **Substitution.** Every implementation of a port, fakes included, honours the same contract, with no special cases for one of them. Flag a fake that's more forgiving than the real thing.
- **Narrow ports.** A consumer depends only on what it uses. Flag a wide port that callers only partly use.
- **Dependencies point inward.** The core depends on ports in `contracts`, is handed them, and never builds its own collaborators. It reads no globals either: time, randomness, environment, files, network and console come in through ports, so a run repeats exactly and goldens stay stable.

**Then the shape of each piece.** Use the smallest shape that fits:

| When the code… | Use | Instead of |
|---|---|---|
| makes a decision and needs no collaborators | a pure function | a service |
| does work that needs collaborators or state | a service from a factory that's handed its ports, such as `createRunService(ports)` | loose functions passing the same arguments around |
| behaves differently for each case of a union | a table keyed by the union, checked with `satisfies Record<Kind, …>` so a new case won't compile without an entry | a `switch` on the same union in several places |
| can fail in ways that are expected | a `Result` from `contracts`, or another union of outcomes, that the caller switches on | throwing, or an `undefined` that can mean several things |
| needs a timeout, logging or redaction | a wrapper that returns the same type, such as `withSecretRedaction(redactor, secrets)` (decorator) | the same `try`/`catch` or call in each caller |
| has an optional collaborator | a do-nothing implementation passed in, such as an `EventSink` that discards (null object) | `if (sink)` wherever it's used |
| must be set up and cleaned up | a scope, such as `withSession(run)`, which may use `await using` inside: a bare `await using` can be forgotten and still compile | a call order callers have to remember |
| has a lifecycle | a union of states, and functions that only accept the state they need (typestate) | flags, nullable fields and `if (session === null)` checks |
| runs several steps | a sequencer over a list of steps, each doing its own detail (pipeline) | one function that sequences and does the detail |
| chooses an implementation: production or test, which driver | the composition root, the one file in `cli` that builds adapters and hands them in | `if (isProduction)` or a driver check in the core |
| stands in for a port in tests | one complete fake per port, from a factory that takes overrides, such as `fakeDriver(overrides)`, and `fakePorts(overrides)` for the whole set | `{} as RunPorts`, or a partial fake built in each test |

Pure logic (parser, policy, oracle, secrets) stays as pure functions, one role per file. A file that is a bag of loosely related functions passing the same arguments around is a missing service, or several files. Flag anything in the *Instead of* column, and a heavier shape than the job needs: a service or factory that wraps one function for no gain, or a seam with no second implementation or test double to justify it. A class hierarchy or DI container is also a finding.

**And the guarantees, which are always `must fix`:**

- **Guarantees kept.** Deny by default, decoders report code and path only, a fresh browser per run in production, and the version check.
- **Secrets stay opaque.** Code may carry a `Secret` but not read it. Secrets are wrapped as soon as they're loaded, only the modules in `REVEAL_ALLOWED_MODULES` call `reveal()`, and none of them hands the plain value back to its caller. A new entry on that list is a `must fix` that goes to the founder, not the code helper.
- **Behaviour unchanged.** No refactor commit changes a golden. Tests may change how they call the code, but not what they assert: flag a test that was skipped or loosened. A test may be deleted once what it covers can no longer happen, such as a case the types now refuse; flag a deleted test whose behaviour can still happen.
- **Nothing retries.** Flag anything that tries again or carries on as if a failure hadn't happened: a retry loop, a fallback to another locator or path, a `catch` that discards an error, or a test runner's `retries` setting. Clean-up can't change a verdict, but a clean-up that fails is reported, not discarded. A `catch` may handle only the specific expected case it names, such as a process that has already ended. A `.catch(() => undefined)` usually means the call should return an outcome instead of rejecting, so the fix is in what it calls. A command or input is sent once. Sending it again because it failed or had no effect is a retry, and that includes a click the page swallowed. Re-reading or re-locating before that one send, under one deadline, is waiting.

**Run** ESLint on the files `<COMMITS>` changed, with every suppression ignored. `--no-inline-config` ignores `eslint-disable` comments, and an empty suppressions file outside the repo stands in for `eslint-suppressions.json`:

```sh
echo '{}' > /tmp/no-suppressions.json   # any path outside the repo
node tools/eslint/node_modules/eslint/bin/eslint.js --config tools/eslint/eslint.config.js --no-inline-config --suppressions-location /tmp/no-suppressions.json <changed files>
```

Any `no-nested-ternary`, `strict-boolean-expressions`, `no-unnecessary-condition` or `no-unsafe-*` hit in code this part touched is a `must fix`: these don't wait for the later clean-up.

Then run the secret reveal check, `tools/check-secret-reveal.ts`, the way the repo runs it. A failure is a broken guarantee.

**Report** in at most 40 lines, most serious first. For each finding, give the file and line, the check it fails, what goes wrong in concrete terms (the change that becomes hard, or the input that breaks it) and the smallest fix. If you can't name what goes wrong, it's taste, and taste isn't a finding. Mark each one:

- `must fix`: a broken guarantee or changed behaviour; a hit from the four rule families named above; or any other check failing in code this part changed, or in a caller that still has to make up for it.
- `consider`: the same kinds of problem in code this part didn't touch, or a change that would help though nothing is wrong yet.

End with a verdict: `clear` if nothing is `must fix`, otherwise `not clear`. Say "no findings" if there are none.

Change no files and don't commit, apart from the scratch file above. Don't start other agents.
