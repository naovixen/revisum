# Architecture refactor: decisions, cuts, evidence and what changed

## In short

- The founder paused spec work on 2026-11-02 because CI had grown from 6 to 41 minutes and adding one step took about 34 edits in 14 files. `docs/architecture.md` describes the result.
- The refactor kept the code rather than rewriting it, and reviewed each area for bugs before moving it. Fixes are in `docs/decisions/refactor-defects.md`; assumptions awaiting the founder's check are in `docs/decisions/refactor-assumptions.md`.
- Two of the plan's numbers were not met or aren't known. Adding a step takes about 18 edits rather than about 7, though nearly all are forced by a tool. CI's 10-minute target is unmeasured until the founder pushes.
- The evidence for the design is mostly this code's own measurements. Outside sources are largely practitioner writing, and **no experiment was found showing that any structure makes AI agents better**.

## Decisions

| Decision | Choice | Source |
|---|---|---|
| Plan language | One version; old grammars and migrator deleted; goldens regenerated once | Founder |
| Playwright driver | Retired; Chromium only in phase 1; the driver port stays for a second driver | Founder |
| Push tier | Core tests on push, fully optimised; repeats and secondary targets weekly | Founder |
| `bin` and commands | Not in this refactor; the CLI spec builds them | Founder |
| Test tag and spec references in code | Removed; a repository rule stops them returning | Founder |
| Bugs in existing code | Find and fix them during the refactor, using judgement; don't preserve behaviour just because it exists | Founder |
| Context during the rebuild | Fresh helpers per task; the main session stays small | Founder |
| Magic strings | Enum-like constant objects, since real `enum`s can't run under Node's type stripping | Founder |
| Function style | `function` where it fits, arrows elsewhere; no mass conversion | Founder |
| Product's `criterionId` in plans | Kept: a customer feature, not the test tag | Proposed |
| Licences, tests-apart rule, founder push as approval | Unchanged | Standing rules |
| Trust rules (imports, brands, secrets) | Stay in repository rules, not ESLint, where suppressions would become opt-outs | Stress test |
| Golden rule | A refactor commit may never change a golden; a fix commit may, and names its defect in a `Defect:` trailer (`tools/repo-rules/commits/CheckGoldenChanges.ts`) | Plan |
| Reviews don't pause the work | After a part's second review, fix what it found, record it and tick it | Founder, 2026-11-04 |
| Run to the end without stopping | Take the recommended option and list the assumptions for validation | Founder, 2026-11-08 |

## Findings

### Why it was needed

From the plan's measurements on 2026-11-02; `docs/decisions/refactor-baseline.md` holds the CI and browser figures.

| Problem | Evidence |
|---|---|
| CI took 41 minutes, 37.4 of them tests | One step, no caching, no early exit |
| 22% of tests took 99% of the time | 1,047 tests against 3,640 taking 27 seconds in total |
| One new step meant about 34 edits in 14 files | Traced for `expectClipboard`; 7 lists not compiler-checked |
| Step tree walked by hand | 8 copies of frame and tab recursion |
| The run file mixed types, pipeline and execution | 1,040 lines, 41 hand-built failures, a refusal block copied 4 times |
| The plan parser in one file | 1,439 lines, 64 decode functions |
| Four overlapping driver capability systems | Plus about 17 engine rechecks |
| `plan` and `project` folders imported each other | Now one way only, by rule |
| Public surface too wide | 117 of 168 named engine exports unused by other packages |

### Cut list

Each was confirmed gone from `packages/` and `tools/`, or kept as stated.

| Cut | Why | Status |
|---|---|---|
| `driver-playwright` | Founder decision | Gone; evidence mode's report decoder and stand-in fixture stay |
| `action` stub | Held only `export {}` | Gone; the CLI spec recreates it |
| Plan 1.1 and 1.2 grammars, `migratePlan` | Founder decision | Gone; `CURRENT_PLAN_VERSION` is the only version read |
| `coverage-study` engine and tool | Question resolved by the language-fit pivot | Gone; the reports stay in `docs/coverage-study/` |
| `seed-from-research`, `seed-provenance`, `check-seed-provenance`, `check-research-links` | Guarded a finished seeding; proofs cost 89s | Gone; the research ban in code stays via the naming lint |
| `check-branch-gates`, `cost-report` | No CI use; no hosted costs yet | Gone; reinstate from git when hosting starts |
| Test tag and its tooling | Founder decision | Gone; `Criteria:` commit trailers remain |
| Duplicate `axe-audit` | Copy of `auditor-axe` | Gone with Playwright |
| Driver's duplicate audit rules | Overlap with `auditor-act` | **Kept for the accessibility spec:** `packages/driver-cdp/src/capabilities/PageAuditRules.ts` |
| Unused engine exports | Dead | Trimmed; `test/unit/engine/EnginePublicApi.test.ts` pins what packages built on the engine need |

**Kept although currently uncalled:** `runUntrusted`, the report API, the runners and release notes.

### Research basis, and how strong it is

**Most of this rests on the code's own measurements**, which are stronger than the outside sources. Those sources are largely practitioner writing rather than controlled studies.

| Idea | Support | Strength |
|---|---|---|
| Functional core, ports and adapters | Bernhardt's pattern, seen only through secondary summaries | Widely used; primary sources not read |
| Small interfaces, feature-grouped code for AI | Practitioner surveys and articles | **Opinion, not evidence** |
| Exhaustive handling of unions | Established TypeScript technique | Strong |
| `as const` objects instead of enums | TypeScript Handbook, seen only as quoted secondhand; `erasableSyntaxOnly` rejects enums | Strong as practice; Handbook page not read directly |
| One browser, fresh context per test | Playwright docs and guides | Common practice; no timings, hence phase 0 |
| Many fast tests, few slow ones; run fast stages first | Standard test pyramid | Strong as a convention |
| Time-budgeted CI | Shopify engineering, TU Wien thesis | Good case evidence |
| Under 10 minutes for feedback | DORA, via a secondary source | **Not confirmed against dora.dev** |
| `node:test` starts one process per file | Node docs and a practitioner report | Consistent with what we see here |
| 2,000 free minutes a month | GitHub billing docs | Strong |

Sources:

- [Functional core, imperative shell notes](https://kyle.au/notes/technology/development/functional-core-imperative-shell-pattern)
- [`exhaustive` for TypeScript unions](https://github.com/lukemorales/exhaustive)
- [`as const` objects and the Handbook's position (Japanese)](https://zenn.dev/sonsu/articles/270319f20b0390)
- [Enums and `erasableSyntaxOnly`](https://coddy.tech/docs/typescript/enums)
- [Exploring TypeScript: enums](https://exploringjs-com.onrender.com/ts/book/ch_enums.html)
- [Browser and context in Playwright](https://www.browserstack.com/guide/playwright-browser-context)
- [Playwright browser contexts isolation guide](https://qaskills.sh/blog/playwright-browser-contexts-isolation-guide)
- [Deep modules in AI-augmented codebases](https://github.com/davidamitchell/Research/wiki/2026-04-30-deep-modules-ai-augmented-codebases)
- [Vertical slices for AI-generated code](https://www.managed-code.com/blog-post/vertical-slice-architecture-for-ai-generated-code)
- [Architecture for AI agents](https://codemyspec.com/blog/agentic-architecture)
- [Shopify: test budgets for CI feedback](https://shopify.engineering/test-budget-time-constrained-ci-feedback)
- [Zumtobel, time-constrained testing (TU Wien)](https://repositum.tuwien.at/bitstream/20.500.12708/202327/1/Zumtobel%20Rene%20-%202024%20-%20Balancing%20Time%20and%20Test%20Coverage%20A%20Time-Constrained...pdf)
- [Test pyramid glossary, including the DORA reference](https://aicodereview.cc/glossary/test-pyramid/)
- [Test pyramid in AI-assisted development](https://www.minware.com/blog/test-pyramid-ai-assisted-development)
- [`node --test` in practice](https://dev.to/grimicorn/node-test-the-test-runner-you-already-have-installed-544a)
- [TypeScript project references](https://www.typescriptlang.org/docs/handbook/project-references)
- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub's plans](https://docs.github.com/en/get-started/learning-about-github/githubs-plans)

### What actually changed against the plan

The plan's names below are as it wrote them. "Assumption" numbers are rows of `docs/decisions/refactor-assumptions.md`.

| Topic | Plan said | Code does | Why |
|---|---|---|---|
| Edits to add a step | About 7, each compiler-forced | 16 measured by the throwaway step before the move; 18 by reading today's code: the starting edit, 16 forced by `tsc` or a repository rule, 1 by a unit test | The extra entries each state a decision about that step; assumption 29 |
| CI on push | 41 minutes to 10 or less | **Not measured.** The jobs are split (fast, three browser shards, proofs, replay, containers) with a 15-minute limit, but the founder hasn't pushed | Waits for the end of the refactor |
| The run's way in | `createRunService(parsePlan, ports)`, `run(inputs)` | `createRunService(ports)`; `run(cleared, inputs)` takes only a `ClearedRun`; `runUntrusted(input, parsePlan, inputs)` | A run under another project, target or standing can't be expressed |
| Lifecycle | An `Authorised` mark | Gone; `ClearedRun` carries the rule | Nothing read the mark; assumption 36 |
| Pipeline: trust | Stops with `NeedsApproval` | Gives a standing, approved or proposal; a proposal is judged more strictly and never reaches production | There is no such stop in the code |
| Pipeline: oracle | A stage after the executors | Pure functions in `packages/engine/src/run/outcome/Verdict.ts`, called per check by the executors | A check polls until it passes or times out |
| Pipeline: preflight | Origin, secrets, scripts, services, storage state, database steps, element states | The same, plus a base URL off the project's origins, first | Defect 244 |
| Driver port | Optional methods removed | Done, except `build`, still optional; `supports` stays | A driver may be unable to pin its browser |
| Driver factory | `cdpDriver({ browserProvider })` | `cdpDriver({ executablePath, egress, browserSource })` | `egress` is required, so no driver opens without its proxy |
| Runner port | Not specified | `withRun` alone; the level comes from the run itself | Overlapping runs; assumption 19 |
| A broken driver | Not specified | Ends `Errored` with `PlanDriverBrokeResult` | It says nothing about the target; assumption 6 |
| Tables | `STEP_DECODERS`, `STEP_SCHEMAS` | One `StepReaderTable` per section joined in `STEP_READERS`; `STEP_FIELD_SCHEMAS` and `STEP_TYPE_FIELD_SCHEMAS`, not exhaustive, but a missing field stops the schema building | Defect 429 |
| Helpers in the contracts foundation | `readFields`, `stepFailed`, `refusedResult` | Only `stepFailed` there; `readFields` is in `packages/engine/src/plan/ReadFields.ts`, `refusedResult` in `packages/engine/src/run/seal/RefusedResult.ts` | They read engine types |
| `literalActionStep` stays as the last refusal | Stays | Gone. Driver ports take resolved types, and `packages/contracts/src/plan/LiteralText.ts` is the one place that tells literal text from a reference | Replaced when the port took resolved types |
| Composition root | Later, with the CLI spec | Built: `packages/cli/src/wiring/BuildAdapters.ts`. `bin` is still to come | So no caller can open a browser without its proxy; assumption 27 |
| Folder names | The plan's `trust`, `targets`, `results`, `egress`, `workloads` | `approval`, `target`, `run-result`, `egress-proxy`, `workload` | Moving again gains nothing; assumption 32 |
| Extra folders | Not in the plan's tree | Engine `decoding` and `foundation`; `run` subfolders; contracts `modes`; driver `testing`; runner `service-calls`; `packages/cli/src/wiring` | Where the code landed |
| Engine layers | Service over a pure domain | A convention: `packages/engine/src/policy/PolicyGate.ts` and `packages/engine/src/approval/PlanStanding.ts` import `planHash` from the seal folder. Only cycles and project-to-plan are enforced | — |
| Layout rules | Enforced by the layout check: no loose files, at most 12 code files per folder, feature folders, tests mirror source, test data apart | `tools/repo-rules/CheckLayout.ts` checks only where source and tests live and each package's required files. The first two hold today; no tool checks them | Unbuilt |
| Provider wire formats | Move to the CLI, so the engine names no vendor | Adapters are in `packages/cli/src/planners/PlannerAdapter.ts`; `packages/engine/src/drafting/PlannerRequestBody.ts` still names the wire formats | Moving them changes a dependency; assumption 33 |
| Magic strings | Baseline only strings outside any union | 730 baselined for phase 6; the rule is off for tests | Assumptions 34 and 35 |
| Suppressions | Burnt down in phase 6 | 3,903 in 428 files at 2026-11-09, 2,514 of them test titles | Phase 6 |

The defect log, the test ledger (`docs/decisions/refactor-test-ledger.json`) and the assumptions list hold the detail on every behaviour change.

## Risks

- **CI speed is unproven.** The target is met or missed only on the founder's push.
- **37 assumptions await validation**, including one that touches a false pass (assumption 31).
- **Real Chromium behaviour and real Docker text are partly assumed.** Assumptions 7, 11, 21 and 23 are marked as not observed.
- **Layout and engine-layer rules can drift**, because no tool checks them.
- **The driver port has one implementation**, so the withdrawn guarantee stays withdrawn until a second driver exists.
- **The evidence for "AI-friendly" structure is opinion.** Keep the design for what it does for a human reader and the compiler.
