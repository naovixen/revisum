# Refactor defect log

## In short

- The architecture refactor treats existing code and tests as evidence, not truth. Anything suspected of being wrong is recorded here with a decision, so it is neither carried over silently nor investigated twice.
- A refactor commit may never change a golden. A fix commit may, and must name its defect here, with a `Defect: <number>` trailer naming that row. `tools/CheckGoldenChanges.ts` enforces this in CI.

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
| 2 | `checked`, `unchecked` and `focused` fail as `assertion-failed` after a full poll, instead of being refused up front | `engine/src/oracle.ts:117`, `contracts/src/literal-steps.ts:116` | not a bug | `needsDriverFeatures` always answers true for these, on every driver, so the step fails with `unsupported-step` and never probes. `ElementChecksNoDriverDecides.test.ts` pins it. The oracle's branch is only the switch's exhaustive, fail-closed end |
| 3 | `storageState` is refused at the first step, not before the run | `engine/src/run.ts:632` | fixed | Phase 1: refused with `storage-state-unsupported` before a browser opens. The parser still accepts it (SPEC-04, AC-06) |
| 4 | Download listener never removed; downloads not scoped to a context | `driver-cdp/src/downloads.ts:85`, `:99-105` | suspected | Phase 2, with browser reuse. A review found it harmless with a fresh browser per run, because the connection dies with the browser and the only other page is an idle about:blank. It's real on a shared browser, where close never stops the watch. The production form is finding 36 |
| 5 | Runner's `level` is per runner, not per run, so concurrent runs may share it | `runner/src/docker-runner.ts:52,57` | suspected | Phase 3 |
| 6 | A clipboard check waits the full timeout on over-long text, while a remember fails at once | `engine/src/clock-and-clipboard-steps.ts:118`, `:136` | suspected | Phase 3 |
| 7 | Refusal codes mix styles (`origin_not_allowed`, `secret-missing`) | `engine/src/run.ts:327`, `:336` | fixed | Phase 1: the refusal is `origin-not-allowed`. Parser codes keep underscores; every run-time code has hyphens |
| 8 | String-typed result codes let typos through | `engine/src/run.ts:126`, `:484` | suspected | Phase 3 |
| 9 | A test may keep passing while proving nothing after the quote change | `test/unit/report/report-generator.test.ts` | suspected | Phase 4 |
| 10 | PR comment's 1,800-character limit is checked only by a test | `report/src/render/pr-comment.ts:10-12` | suspected | SPEC-12 |
| 11 | Masks use plain `querySelectorAll`, so they miss shadow DOM | `driver-cdp/src/in-page.ts:139` | suspected | SPEC-09 |
| 12 | Explore returns `plan-rejected` where SPEC-16 needs `after-plan-failed` | `cli/src/explore-crawl.ts:90` | suspected | SPEC-16 |
| 13 | The pure code that decides pass or fail has 23.9% branch coverage from unit tests, and no test calls `checkElement` directly. Four browser files lift it to 79.5%, and the `hidden` branch (lines 98-100) stayed uncovered in those runs. Its verdicts rely on slow tests | `engine/src/oracle.ts` | suspected | Phase 3: add fast unit tests |
| 14 | With Playwright gone, `device-not-supported` can't happen in real code; only a fake covers it | `test/unit/engine/target-resolution.test.ts:122-156`, `driver-cdp/src/cdp-driver.ts:194-202` | suspected | Phase 3: keep for SPEC-19 or remove |
| 15 | `Resolved -> Errored` stays in the lifecycle table with nothing using it, now that the dead `lifecycle.abort` is gone | `engine/src/lifecycle.ts` | suspected | Phase 3 |
| 16 | A target's `kind` and `provider` still parse, but nothing reads them | `engine/src/project/project-parser.ts` | suspected | Phase 3 |
| 17 | `assertion-values.test.ts` named a target no longer in the matrix, so its 13 tests failed after Playwright's removal until repointed | `test/unit/engine/assertion-values.test.ts` | fixed | Repointed at `cdp-chromium` in the plan-version commit. The Playwright helper's list missed it, so **a full run is needed to catch others** |
| 18 | Database steps with no command runner fail mid-run after earlier steps have acted, and a cleanup command lets the run pass with a review item | `engine/src/run.ts:628`, `:722`, `service-calls/call-steps.ts:207` | fixed | Phase 1: refused with `database-commands-unavailable` before a browser opens, cleanup included |
| 19 | A driver's feature list is hashed, so adding a feature changes every plan's manifest hash | `engine/src/manifest.ts:287`, `replay/manifest-decoder.ts:80-90` | fixed | Phase 1: `performs` left the manifest; adapter id, version, protocol and `cannotPin` stay |
| 20 | `checked`, `unchecked` and `focused` can never pass on any driver, yet earlier steps still act before the step fails. The language accepts checks nothing can perform | `contracts/src/literal-steps.ts:116`, `engine/src/run.ts` | suspected | Phase 3: refuse in preflight, or remove from the language. Hash-visible, so a named fix commit |
| 21 | No run reaches `secretRecords`' storage-state branch any more, so only `buildManifest` tests that record | `engine/src/run.ts` | deferred | Restore a run-level test when a driver loads saved state |
| 22 | Some run-time codes have no union or docs heading (`a11y-violations`, `adapter-error`, `expected-failure`, `spec-ambiguous`, Unavailable reasons such as `launch-failed`), and `assertion-failed`'s heading covers only the dialog case | `docs/errors.md`, `engine/src/run.ts` | suspected | Phase 3, with finding 8 |
| 23 | The export cleanup removed `Success` and `Failure` from the public API, though `Result` is built from them and SPEC-27 declares them. Its check covered only M3 and M4 specs. Only the full run caught it | `contracts/src/index.ts` | fixed | Exports restored. Other removals could share this gap: phase 3's review checks them against every built spec |
| 24 | `test/proofs/shared-types.test.ts` reads a spec's type block, so a proof depends on a spec document, against the rule that tests stand alone | `test/proofs/shared-types.test.ts` | suspected | Phase 3: pin the public types directly |
| 25 | The Linux half of the host clipboard proof has never run: it needs `xclip`, which nothing installed. CI now installs it, so the first push runs this proof on Linux for the first time | `test/contract/host-clipboard.ts:250-258`, `tools/install-system-libraries.sh` | suspected | Watch the first push; rebuild the dev container so `check:linux` runs it too |
| 26 | The secret lint misses `(await import(x)).reveal`, `namespace['reveal']` and `import(x).then(({ reveal }) => …)` (each planted and not caught) | `tools/check-secret-reveal.ts` | suspected | Phase 3 |
| 27 | The brand lint misses `const plan: Plan = JSON.parse(text)`, which has no cast at all, plus `as undefined \| Plan`, `as Readonly<Plan>` and `as Array<Plan>` (planted, not caught) | `tools/check-branded-casts.ts` | suspected | Phase 3. `run()` also checks the brand at run time, which limits the damage |
| 28 | The runtime import lint and route imports miss a template-literal specifier such as ``import(`puppeteer`)`` (planted, not caught) | `tools/check-runtime-imports.ts`, `tools/check-imports.ts` | suspected | Phase 3 |
| 29 | The person-gate lint misses `['person-verified'].includes(type)`; the approval lint misses `const level = a.strength; level === 'verified'` (planted, not caught) | `tools/check-person-gates.ts`, `tools/check-approval-strength.ts` | suspected | Phase 3 |
| 30 | Dependency reviews check only the file part of `file#title` evidence, so a retitled test goes unnoticed. `check-imports` reads only `dependencies`. `check-licences --modules` with no value falls back silently (from reading the code, not run) | `tools/check-dependency-reviews.ts`, `tools/check-imports.ts`, `tools/check-licences.ts` | suspected | Phase 3. The first matters before phase 6 retitles tests |
| 31 | False pass: the tab crashes, then `absent`, `hidden` or `countEquals 0` runs. `probe` has no crash check, a swallowed error reads as count 0, and `poll` returns a pass before it looks at `crashed()`. A crash in the last check gives a Passed run | `driver-cdp/src/browser-session.ts:70`, `:274-282`, `engine/src/run.ts:962-963` | suspected | Phase 2, before browser reuse: failing test, then fix |
| 32 | False pass: a click opens a confirm dialog, then `hidden` or `absent` runs. `probe` returns count 0 while a dialog is open, so the check passes with the element on screen | `driver-cdp/src/browser-session.ts:278` | suspected | Phase 2, before browser reuse |
| 33 | The whole browser dies or the socket drops, and `failAll` tells nobody, so `crashed()` stays false. Negative checks pass as in 31; other steps report `not-found`, not `target-crashed` | `driver-cdp/src/cdp-connection.ts:41`, `page-watch.ts:71-77` | suspected | Phase 2, before browser reuse, which makes it more likely |
| 34 | Any thrown read counts as "no element", including context loss during a navigation or a page's overridden DOM functions, so `absent` and `hidden` can pass with the element present | `driver-cdp/src/browser-session.ts:70`, `:292` | suspected | Phase 2, before browser reuse |
| 35 | A click on a link to a slow attachment passes, because openings are counted two frames later and a download begins when headers arrive. Popups and downloads during `navigate` or a check are never counted | `driver-cdp/src/browser-session.ts:403-407` | suspected | Phase 3 |
| 36 | The first download while armed is claimed whatever started it, with `frameId` ignored, so a page timer's file can pass a download step whose click did nothing | `driver-cdp/src/downloads.ts:102` | suspected | Phase 3 |
| 37 | `armed` is cleared, then `#discard` can wait up to 2 s before `deny`, so a download begun in that gap is saved and stays on disk until close | `driver-cdp/src/downloads.ts:197-200` | suspected | Phase 3 |
| 38 | Windows: `void #discard`, and `rmSync` can throw EBUSY. By Node's default rules that unhandled rejection ends the process | `driver-cdp/src/downloads.ts:107`, `:226` | suspected | Phase 3 |
| 39 | Egress: Fetch never holds WebSockets and they aren't in `blockedOrigins`, so where no proxy runs, `wss://` to an undeclared origin connects and the run shows nothing blocked. `--host-resolver-rules` never applies because the driver always passes its own flags | `cli/src/benchmark-runs.ts:158`, `cli/src/explore-in-container.ts:81`, `driver-cdp/src/chromium-launcher.ts:24`, `:107`, `cdp-driver.ts:206` | suspected | Phase 3: proof first. The fix makes isolation stricter; flag it in the phase-end report |
| 40 | Shared browser: any live or stale watch releases a paused page in another context, so run B's popup can run before B sends `Fetch.enable` | `driver-cdp/src/page-watch.ts:100`, `:190` | suspected | Phase 2, with browser reuse. No production effect |
| 41 | Linux: `kill()` is SIGTERM and `await exited` has no limit, so a browser stuck in shutdown hangs `close()` forever. SIGKILL only runs after that wait | `driver-cdp/src/chromium-launcher.ts:101`, `:128-131` | suspected | Phase 3 |
| 42 | No signal handlers exist, and `detached` puts the browser in its own group on Linux, so killing Node leaks the browser and its profile | `driver-cdp/src/chromium-launcher.ts:114` | suspected | Phase 2 for the shared test browser; the production part in phase 3 |
| 43 | A tab closes or crashes with a matching request in flight. No `loadingFailed` arrives, so `quiet` fails with a false `timeout` | `driver-cdp/src/network-stubs.ts:137` | suspected | Phase 3 |
| 44 | Windows: `remove()` can throw after its retries, so `close` rejects inside the run's `finally` and the run's result is lost | `driver-cdp/src/cdp-driver.ts:283`, `engine/src/run.ts:408` | suspected | Phase 3 |
| 45 | The tab claim ignores the `targetId` from `createTarget`, so a noopener popup in that window is taken as the tab, and the real tab is closed uncounted | `driver-cdp/src/page-watch.ts:91` | suspected | Phase 3 |
| 46 | Shared browser: `disposeOnDetach` never fires on a kept connection, so the last run's pages keep running. Recorder and Fetch listeners are never removed | `driver-cdp/src/egress-records.ts:51-64`, `cdp-driver.ts:322` | suspected | Phase 2, with browser reuse: one connection per run |
| 47 | Egress, depends on Chromium: `Fetch.enable` reaches page sessions only, so out-of-process iframes, service workers and shared workers may be neither held nor recorded where no proxy runs | `driver-cdp/src/page-watch.ts:107`, `egress-records.ts:67`, `:73` | suspected | Phase 3: cheap proof with no proxy and a fake-origin server |
| 48 | Depends on Chromium: a stubbed 3xx reuses the request id, so the followed request is dropped from egress records and inherits the stub's body. Whether a stub may set `Location` is unchecked | `driver-cdp/src/egress-records.ts:30`, `network-stubs.ts:267` | suspected | Phase 3 |
| 49 | Egress, depends on Chromium: preconnect, dns-prefetch and WebRTC also sit outside Fetch | `driver-cdp/src/page-watch.ts` | suspected | Phase 3, with 39 and 47 |
| 50 | A no-fast-forward merge into `main` would fail the push `tests-apart` check, because a merge is compared with its first parent, which mixes tests and code | `tools/check-tests-apart.ts` | suspected | Decide at the branch merge: a fast-forward avoids it |
| 51 | On a new branch's push, the old step ran `git rev-list` after the workspace's owner changed, so git may have refused to read it | `.github/workflows/ci.yml` | suspected | The new CI runs it before the owner changes. The first push confirms it |
| 52 | The old `.test-results/tests-test-unit+test-contract.jsonl` stays on existing machines, so it can hide a missing file from `--require-results` and still count old failures. CI starts clean | `tools/run-test-folder.ts` | suspected | Delete the file locally before the next `check:push`; phase 3 decides whether the tool should clear it |
| 53 | Real-container tests write no results file, so gates can't see them, only whether their job passed | `.github/workflows/ci.yml`, `test/containers/` | suspected | Already the case. Phase 3 |

## Risks

- A review can miss a real bug. Cold reviews, a mutation spot-check on the trust path and a final trust-path review reduce that risk but don't remove it.
