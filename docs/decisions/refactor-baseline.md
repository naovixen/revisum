# Refactor baseline

Measured on 2026-11-02, before the architecture refactor. Later phases compare against these numbers.

## In short

- CI takes 41 minutes, and 37.4 of them are tests: unit and contract 23.1, proofs 13.9, replay 0.4. Types and lint take under 10 seconds, so they aren't the problem.
- Browser launch and stop cost about 0.9 to 1.6 seconds per run. A fresh context on a shared browser costs about 0.16 seconds. Reuse could save 9 to 20 minutes locally across the 700 to 900 launches in a full run (estimated launch count).
- The 10-minute push target looks reachable. It stands, to be proved by a real push at the end of phase 2.

## Decisions

- **Browser reuse is worth its driver fixes.** The saving is large enough to justify scoping auto-attach, downloads and the clipboard per context.
- **Lint proofs matter in CI, not just locally.** Proofs take 13.9 minutes on the runner because it has fewer cores, so the fix goes ahead in phase 2.
- **`#test-support/*` is adopted.** A Node subpath import in the root `package.json` works with Node's type stripping and TypeScript's `nodenext`, checked with `tsc -p test`. Moving a test won't break its helper imports.
- **Coverage must not fall.** The table below is the floor for trust-path folders.

## Findings

### CI, by stage

Run 41337661031, on `ubuntu-24.04`.

| Stage | Minutes |
|---|---|
| `npm ci`, system libraries, browsers | 1.4 |
| `tsc --build`, `npm run lint`, `lint:names` | 0.1 |
| `npm test` (unit and contract) | 23.1 |
| `npm run proofs` | 13.9 |
| `npm run replay` | 0.4 |
| Real-container tests | 1.8 |
| **Whole job** | **41** |

The log doesn't state the runner's size. GitHub's billing table lists the standard Linux runner as 2-core, so that is assumed until a CI step prints `nproc`. This run predates the `lint:code` step, which adds about 30 seconds.

### Browser cost

Windows, this machine, Chrome for Testing 156. The second row's range comes from two samples, one while the machine was also running tests.

| Operation | Median |
|---|---|
| Launch | 400 to 490 ms |
| Stop and remove the profile | 525 to 1,121 ms |
| New context and page on a running browser | 132 ms |
| Dispose of a context | 31 ms |

### Tests

`docs/decisions/refactor-test-ledger.json` records 4,687 tests in 243 files, from the last full local run, excluding the 11 container test files. Any test removed later is accounted for by reason.

- 3,640 tests under 100 ms take 27 seconds in total.
- 1,047 tests take the other 2,557 seconds.
- 55 browser files run one at a time and take 1,604 seconds.

### Coverage floor

Unit tests only (`test/unit`), Node 24's `--experimental-test-coverage`, 3,624 tests in 92 seconds, all passing. Figures are per-file averages for each area, not weighted by lines.

| Area | Line % | Branch % |
|---|---|---|
| All packages | 86.0 | 79.4 |
| `engine/approval` | 99.8 | 83.6 |
| `engine/lifecycle.ts` | 97.1 | 100.0 |
| `engine/manifest.ts` | 100.0 | 91.8 |
| `engine/oracle.ts` | 70.8 | **23.9** |
| `engine/plan` | 96.2 | 89.9 |
| `engine/policy` | 98.2 | 90.0 |
| `engine/project` | 97.2 | 80.1 |
| `engine/redaction.ts` | 100.0 | 100.0 |
| `engine/run.ts` | 85.7 | 83.1 |
| `engine/secrets` | 95.1 | 86.9 |
| `runner/address-check.ts` | 100.0 | 94.0 |
| `runner/egress-events.ts` | 96.9 | 96.2 |
| `runner/egress-policy.ts` | 100.0 | 100.0 |
| `runner/egress-proxy.ts` | 94.0 | 82.8 |

## Risks

- **Browser timings come from Windows.** Linux launches may differ, so reuse's real saving in CI is confirmed only by the phase 2 push.
- **The ledger is file-level and from a local run.** It accounts for removed tests by file and reason, not one by one.
- **Coverage excludes browser tests.** Some low unit figures may be covered by contract tests, which this baseline doesn't measure. See `docs/decisions/refactor-defects.md`, finding 13.
