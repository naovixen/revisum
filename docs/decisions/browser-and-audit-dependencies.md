# Dependency reviews: Playwright, axe-core and the browser installer

## In short

- `playwright-core` 1.64.1 is kept as an optional adapter in `driver-playwright` only. It is the fallback driver until the own CDP driver passes the capability contract tests; it never enters `contracts` or `engine`.
- `axe-core` 4.14.0 is kept as a default auditor in `auditor-axe`, and bundled in `driver-playwright` for that driver's audit step. Its files are used unmodified from the npm release.
- `@puppeteer/browsers` 3.2.6 is a root development dependency. It installs the pinned Chrome for Testing build the browser tests drive. It ships in no package and is not on the trust path.
- All three are pinned to exact versions. Each was reviewed before it was added, as SPEC-00 requires.

## Decisions

Each review uses the `DependencyReview` shape from `docs/specs/SPEC-00-repo-seed-and-gates.md`.

| Check | `playwright-core` 1.64.1 | `axe-core` 4.14.0 |
|---|---|---|
| `licenceAllowsUse` | pass: Apache-2.0 | pass: MPL-2.0, file-level copyleft. The files ship unmodified, so no obligation beyond keeping the licence and offering the source |
| `reachesAllTargets` | fail: no branded Safari or Firefox, no real iOS devices | pass: runs in any web page, on every browser engine |
| `versionPinned` | pass: exact version; it pins its own browser builds | pass: exact version, one bundled file |
| `stockBrowsersOnly` | fail: its Firefox and WebKit builds are patched | pass: needs no browser build of its own |
| `gapsClosable` | pass: it is a driver, not an accessibility engine | pass: its keyboard and focus gap is closed by the own engine's probes running beside it |
| `roadmapFits` | partial: one vendor controls it, and it has dropped platforms before | pass, with a watch: contributions go through a vendor licence agreement |
| **Decision** | `optional-adapter` | `default` |

| Development tool | Version | Licence | Why | Decision |
|---|---|---|---|---|
| `@puppeteer/browsers` | 3.2.6, exact | Apache-2.0; its dependencies are MIT and ISC | Downloads Chrome for Testing 156.0.8078.47 into `.browsers/`, the cache layout `test/support/browsers.ts` reads. Run by `npm run browsers`; nothing imports it at run time | Keep, development only |

Evidence:

- Licences: the `license` field and licence file in each package's npm release.
- `axe-core` files unmodified: `auditor-axe` and `driver-playwright` read `axe.min.js` from `node_modules/axe-core` as published; neither package copies or edits it.
- Version pins: `test/unit/auditor-act/rule-set.test.ts` checks that `auditor-axe` depends on `axe-core` 4.14.0 exactly.
- Driver behaviour: `test/contract/driver-contract.test.ts` runs the same contract against the Playwright targets and the own CDP driver.

## Findings

- **Playwright fails two checks, so it stays off the default path.** It is kept only because the own CDP driver does not yet handle iframes, dialogs, uploads and crash recovery. When those pass contract tests, it leaves the default runtime set.
- **axe-core passes every check.** It stays the reference the own accessibility engine is measured against, and becomes an optional cross-check once the own engine checks the same or more WCAG criteria.
- **`driver-playwright` carries its own small axe runner.** A package may import only `contracts`, so the Playwright driver cannot import `auditor-axe`. It injects the same unmodified `axe.min.js` with the same rule tags; the two copies are about 30 lines each.
- **The Playwright browsers are Playwright's own downloads.** `npx playwright-core install chromium firefox webkit` installs the builds pinned by 1.64.1. `npm run browsers` runs it after installing Chrome for Testing.

## Risks

- **CI needs the browsers.** The CI workflow must run `npm run browsers` before `npm run check`, and the Linux image needs Playwright's system libraries for Firefox and WebKit (`npx playwright-core install-deps`). Both are changes to `.github/`, which the founder owns.
- **The browser downloads are not hashed by us.** `@puppeteer/browsers` and Playwright fetch from their vendors' storage over HTTPS. The executable hash is not yet recorded in a lock file (SPEC-05).
- **MPL-2.0 file-level copyleft.** If anyone edits `axe.min.js`, the edited file must be published under MPL-2.0. The rule is: never edit it, only pin a new release.
