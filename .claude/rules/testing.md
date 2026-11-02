---
paths:
  - "test/**/*.ts"
---

# Test rules no tool can check

ESLint enforces the title structure: `Using the X` > `given` > `and` > `when` > `and` > `then it should`. Merged, the titles must read as one sentence describing a behaviour.

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
