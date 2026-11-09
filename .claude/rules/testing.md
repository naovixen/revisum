---
paths:
  - "test/**/*.ts"
---

# Test rules no tool can check

ESLint enforces the title structure: `Using the X` > `given` > `and` > `when` > `and` > `then it should`. Merged, the titles must read as one sentence describing a behaviour.

- Put a test in the folder that says what it needs: `test/unit/<package>/` for one package's behaviour, `test/browser/` for a real browser, `test/proofs/` for hostile plans and trust rules, `test/replay/` for golden runs, `test/containers/` for real containers. Import shared helpers from `test/support/` through `#test-support/*`; data goes in `test/fixtures/` and `test/golden/`.
- A file that imports `test/support/browser/Browsers.ts`, directly or through other test files, is a browser test wherever it sits: it runs one at a time, and `npm test` leaves it out.
- Tests carry no criterion tag or spec reference: traceability lives in `Criteria:` commit trailers.
- Test behaviour through the public API: trigger an action, check the reaction (return value, thrown error, call to a port). Never reach into privates.
- Cover positive and negative paths. Don't add scenarios the types already rule out.
- Set state before the action, in the `given` and `when` levels.
- Prefer real implementations. A stub must satisfy the port's type, or the test can pass falsely.
- Check a spy's arguments and its call count.
- Use `t.mock`, which is restored after each test. Top-level `mock` needs a manual reset.
- Recreate instances in `beforeEach` so tests can't affect each other.
- Test data holds no logic and is never mutated. Use a factory or `structuredClone` for a variant. Some duplication is fine if it keeps a test readable.
- Use `mock.timers`, not real waits.
- Always `await` promises and `assert.rejects`: an unawaited assertion passes silently.
- A test that reads source text must match both quote styles and survive line wrapping.
- Golden replay is the only snapshot-style comparison.
