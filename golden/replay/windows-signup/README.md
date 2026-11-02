# Windows-made replay golden

A run made on Windows. Replayed elsewhere, it must say whether the hashes match, and report a mismatch as per-environment baselines, never as a pass.

- `plan.json`: the sign-up plan of `test/support/signup-harness.ts` on `cdp-chromium`, without its two capture steps, so the result holds no screenshot.
- `manifest.json`: the run's manifest, as `run` wrote it.
- `result-hash.json`: the run's result hash and manifest hash.

## What a replay of it must say

The manifest records the machine as well as the run: `host`, `browser` and `executableSha256`, the sha256 of the browser the engine launched.

- **Same platform and architecture, same pinned browser:** `identical`.
- **Any other machine:** `per-environment-baseline`, because the only inputs that differ are those three. They are among the engine's `PER_ENVIRONMENT_INPUTS`.
- **Any other differing input, such as the engine version or the driver:** `mismatch`, on every machine.

## How it was made

`npm run goldens:record`, on Windows 11 x64 (`win32`, `x64`), with the repository's own harness and the browsers `npm run browsers` installs. `tools/RecordGoldens.ts` runs `test/support/WindowsSignupGolden.ts` twice, in separate processes, and writes these three files only if both printed the same bytes and the run ended `Passed`. It refuses on any other platform or architecture. This README is written by hand.

## When to remake it

Run `npm run goldens:record` on Windows x64 when a change alters what a run of this plan records: the engine version, the CDP driver's version, the pinned Chrome for Testing build, the fixture app or the result's shape. Until then the replay test fails on Windows and still reports a baseline on Linux, so a pin change shows up only on Windows.

Goldens are frozen: a commit that changes this folder needs a `Defect: <number>` trailer naming a row in `docs/decisions/refactor-defects.md` (`tools/CheckGoldenChanges.ts`).
