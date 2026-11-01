# Windows-made replay golden

A run made on Windows, for SPEC-08's AC-SPEC-08-06: replayed elsewhere, it must say whether the hashes match, and report a mismatch as per-environment baselines, never as a pass.

- `plan.json`: the sign-up plan of `test/support/signup-harness.ts` on `playwright-chromium`, without its two capture steps, so the result holds no screenshot.
- `manifest.json`: the run's manifest, as `run` wrote it.
- `result-hash.json`: the run's result hash and manifest hash.

## How it was made

On 2026-11-01, on Windows 11 x64 (`win32`, `x64`), with the repository's own harness and the browsers `npm run browsers` installs:

1. A throwaway script outside the repository called `harness()` from `test/support/signup-harness.ts`, parsed `plan.json` with it and ran it twice on `playwright-chromium`.
2. It checked both runs ended `Passed` with the same result hash, then wrote the first run's manifest and hashes here.

`playwright-chromium` is used because Playwright launches its own browser and has no `build`, so its manifest gains no `executableSha256` once core hashes the executables it launches (AC-SPEC-08-04). A CDP target's manifest would, and the golden would then differ from every later run.

## When to remake it

Remake it the same way, on Windows, when a change alters what a run of this plan records: the engine version, the Playwright adapter's version or features, the fixture app, or the result's shape. Replayed on a machine with the same platform and architecture it must be `identical`; anywhere else, `per-environment-baseline`.
