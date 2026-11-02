# Refactor defect log

## In short

- The architecture refactor treats existing code and tests as evidence, not truth. Anything suspected of being wrong is recorded here with a decision, so it is neither carried over silently nor investigated twice.
- A refactor commit may never change a golden. A fix commit may, and must name its defect here.

## Decisions

Status is one of: `suspected`, `fixed`, `deferred`, `not a bug`.

| Finding | Do |
|---|---|
| Clearly wrong, contained fix | Fix now: a failing test in a tests commit, then the fix in its own code commit |
| The fix makes security or isolation stricter | Fix now and flag it in the phase-end report |
| Changes a spec promise or approved scope, or could weaken security | Stop and ask, with a recommendation |
| Real, but belongs to an unbuilt spec | Defer to that spec |
| Large and not blocking | Defer and schedule |

## Findings

| Id | Suspected problem | Where (before the moves) | Status | Decision and commit |
|---|---|---|---|---|
| 1 | A missing guard allows the action | `contracts/src/browser-driver.ts:184`, `driver-cdp/src/browser-session.ts:376` | suspected | Phase 3 |
| 2 | `checked`, `unchecked` and `focused` fail as `assertion-failed` after a full poll, instead of being refused up front | `engine/src/oracle.ts:117`, `contracts/src/literal-steps.ts:116` | suspected | Phase 1 |
| 3 | `storageState` is refused at the first step, not before the run | `engine/src/run.ts:632` | suspected | Phase 1 |
| 4 | Download listener never removed; downloads not scoped to a context | `driver-cdp/src/downloads.ts:85`, `:99-105` | suspected | Phase 2 |
| 5 | Runner's `level` is per runner, not per run, so concurrent runs may share it | `runner/src/docker-runner.ts:52,57` | suspected | Phase 3 |
| 6 | A clipboard check waits the full timeout on over-long text, while a remember fails at once | `engine/src/clock-and-clipboard-steps.ts:118`, `:136` | suspected | Phase 3 |
| 7 | Refusal codes mix styles (`origin_not_allowed`, `secret-missing`) | `engine/src/run.ts:327`, `:336` | suspected | Phase 1 |
| 8 | String-typed result codes let typos through | `engine/src/run.ts:126`, `:484` | suspected | Phase 3 |
| 9 | A test may keep passing while proving nothing after the quote change | `test/unit/report/report-generator.test.ts` | suspected | Phase 4 |
| 10 | PR comment's 1,800-character limit is checked only by a test | `report/src/render/pr-comment.ts:10-12` | suspected | SPEC-12 |
| 11 | Masks use plain `querySelectorAll`, so they miss shadow DOM | `driver-cdp/src/in-page.ts:139` | suspected | SPEC-09 |
| 12 | Explore returns `plan-rejected` where SPEC-16 needs `after-plan-failed` | `cli/src/explore-crawl.ts:90` | suspected | SPEC-16 |
| 13 | The pure code that decides pass or fail has 23.9% branch coverage from unit tests, so its verdicts rely on slow browser tests, if they're tested at all | `engine/src/oracle.ts` | suspected | Phase 3: review first, then add fast unit tests |

| 14 | With Playwright gone, `device-not-supported` can't happen in real code; only a fake covers it | `test/unit/engine/target-resolution.test.ts:122-156`, `driver-cdp/src/cdp-driver.ts:194-202` | suspected | Phase 3: keep for SPEC-19 or remove |
| 15 | `Resolved -> Errored` stays in the lifecycle table with nothing using it, now that the dead `lifecycle.abort` is gone | `engine/src/lifecycle.ts` | suspected | Phase 3 |
| 16 | A target's `kind` and `provider` still parse, but nothing reads them | `engine/src/project/project-parser.ts` | suspected | Phase 3 |
| 17 | `assertion-values.test.ts` named a target no longer in the matrix, so its 13 tests failed after Playwright's removal until repointed | `test/unit/engine/assertion-values.test.ts` | fixed | Repointed at `cdp-chromium` in the plan-version commit. The Playwright helper's list missed it, so **a full run is needed to catch others** |

## Risks

- A review can miss a real bug. Cold reviews, a mutation spot-check on the trust path and a final trust-path review reduce that risk but don't remove it.
