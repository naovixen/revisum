# SPEC-06: Own CDP driver

## Purpose

Drive stock Chromium through core's own Chrome DevTools Protocol client, with no patched builds and no third-party automation library on the default path (no third-party limits, FD-3; dependency review, R11). It serves "our end-to-end tests are flaky, so nobody trusts a red build" (UP-02) with auto-wait and stable runs, and "we can't honestly say whether it works on Safari or a phone" (UP-07) with stock browsers and named versions.

## Scope and non-goals

- **In:** the own-driver spike's CDP client and shared session layer (P4); the capabilities plan v1.1 needs (iframes, dialogs, uploads, crash recovery); auto-wait (attached, visible, stable, enabled, receives events); role locators from the accessibility tree; headless shell in CI; Linux flake hardening; Playwright kept as an optional fallback adapter behind the same port until the capability tests pass; re-validation on every new Chrome for Testing build with fix hours logged (NFR-14); the rule for returning to Playwright stays in the MVP plan's kill criteria (research `09`).
- **Non-goals:** popups, downloads and multiple pages (`unsupported-step` until phase 2); a general Playwright-class API; Firefox (SPEC-19).

## Interfaces and types

```ts
export type AdapterInfo = { readonly id: AdapterId; readonly version: string; readonly protocol: 'cdp' | 'bidi' | 'webdriver-classic' };
// What a session starts with; nothing else from the run environment reaches it.
export type SessionEnvironment = {
  readonly secrets: SecretStore; readonly fixtures: readonly FixtureReference[];
  readonly seed: number; readonly clockStartMilliseconds: number; readonly policy: PolicyGate;
};
export interface BrowserDriver {
  readonly info: AdapterInfo;                       // e.g. { id: 'cdp', version, protocol: 'cdp' }
  supports(target: Target): true | Unavailable;
  open(target: Target, environment: SessionEnvironment): Promise<Result<Session, Unavailable>>;
}
// Session (the composition of the driver ports), DriverErrorCode and DriverError are shared core types; see SPEC-27.
export type UpkeepRecord = { browser: 'chrome' | 'firefox'; major: number; fixHours: number; revalidatedAt: string };
```

### Build notes (alignment with the seeded code, 2026-10-29)

The seeded `contracts` code and the tests built on it win where they differ from the block above. Marked additions are new with this spec.

- **Seeded shapes stay.** `AdapterInfo`, `SessionEnvironment` and `BrowserDriver` keep their seeded fields; `supports` returns `Result<true, Unavailable>`. Policy reaches the driver as the `ActionGuard` the engine passes to each `act` call, and a secret as `act`'s `secret` argument, not through the environment. `UpkeepRecord` lives in `tools/`, not `contracts`.
- **The guard stays optional on `act`.** Two seeded tests call `act` without one, so making it required would change committed tests. This replaces the M1 exit's "`Session.act`'s guard becomes required". Instead:
  - the engine passes a guard on every `act` call, and a proof checks this;
  - both real drivers, given a guard, resolve the element, build its `ResolvedElement`, ask the guard, and dispatch nothing on a deny (AC-09). For a dialog step the guard gets the dialog's text.
- **Steps this spec makes real on the CDP driver:** `hover`, `select`, `upload` (a declared fixture file set on the file input), `frame` (its steps run inside the iframe's document) and `dialog` (accept or dismiss the open dialog, checking `expectText`). The engine stops reporting these as `unsupported-step`. The Playwright fallback refuses them with `unsupported-step` and nothing dispatched. `remember` stays unsupported until SPEC-30's driver parts.
- **New driver error codes** (addition): `target-crashed`, when the page's renderer dies (CDP `Inspector.targetCrashed` or a closed target); and `unsupported-step`, when a step makes the page open a popup or a second page, or start a download. The popup is closed, the download is cancelled and its partial file deleted, and the step fails. Downloads by a `download` step and `newTab` stay with SPEC-31's driver parts.
- **A crash** fails the step that was running with `target-crashed`, skips the rest, and `close()` still ends every process the driver started (AC-04, AC-07).
- **Headless shell** (AC-01). `tools/install-browsers.ts` also installs the `chrome-headless-shell` build matching `CHROME_FOR_TESTING_BUILD`. The contract suite runs on a second CDP target that uses it, through the same driver with a different executable path.
- **Auto-wait** (AC-03) keeps the seeded checks (attached, visible, stable, enabled, receives the click). The limit for "never actionable" is the step timeout plus 1,500 ms.
- **Runtime imports** (AC-06). A lint in `tools/` fails when any package in the default runtime set imports, or depends on, `playwright`, `playwright-core`, `puppeteer`, `puppeteer-core`, `webdriverio`, `selenium-webdriver` or `chrome-remote-interface`. The default runtime set is every package except `driver-playwright`, the optional fallback. `npm run check` runs it.
- **Upkeep** (AC-08):
  - `docs/decisions/browser-upkeep.json` holds the records `{ browser, major, fixHours, revalidatedAt }`.
  - `tools/browser-upkeep.ts` decodes them and reports the average `fixHours` over the first six Chrome majors. When that average is over 1.8 it prints a flag naming the Playwright fallback rule and exits 1. With fewer than six records, it reports the running average without flagging.
  - A weekly scheduled CI job reads the latest stable Chrome for Testing version from its public version list. When that major is newer than the pinned one, the job reruns the contract and capability suites against the new build. It fails when the new major has no upkeep record.
  - The session adds the record when it moves the pin; the founder's push approves it. Tests use fixture records and a fixture version list, never the network.
- **Capability runs** (AC-02). The capability tests for iframes, dialogs, uploads and a crashed tab run 20 times in one test file, against local fixture pages, in `npm run check:linux`.

## Acceptance criteria

- AC-SPEC-06-01: When the core skeleton's unchanged contract suite (spike P3) runs on the CDP adapter against Chrome for Testing and the headless shell, all 8 tests shall pass (oracle: regression; reuses AC-p4-01, AC-p4-02, AC-p4-29).
- AC-SPEC-06-02: When the capability tests for iframes, dialogs, uploads and a crashed tab run 20 times in the pinned Linux image, every run shall pass (oracle: specified).
- AC-SPEC-06-03: When an element is late, hidden, moving, disabled or covered for up to 400 ms, a click shall land once after it becomes actionable; one that never does shall return `not-actionable` within its timeout plus 1,500 ms (oracle: specified; reuses AC-p4-09 to AC-p4-14).
- AC-SPEC-06-04: When a tab crashes mid-plan, the step shall fail with `target-crashed` and the session shall close cleanly (oracle: specified).
- AC-SPEC-06-05: When a plan uses a popup, download or second page, the step shall return `unsupported-step`, never a partial result (oracle: specified).
- AC-SPEC-06-06: When the default runtime set is built, no file shall import `playwright`, `puppeteer`, `webdriverio`, `selenium-webdriver` or `chrome-remote-interface` (oracle: specified; reuses AC-p4-08).
- AC-SPEC-06-07: When `close()` returns, every process the driver started shall have exited (oracle: specified; reuses AC-p4-21).
- AC-SPEC-06-08: When a new Chrome for Testing major is released, CI shall re-run the contract and capability suites and record an `UpkeepRecord`; if fixes average over 1.8 hours per major across the first 6, CI shall flag the Playwright fallback rule (oracle: specified).
- AC-SPEC-06-09: When an action step runs, the driver shall resolve its element and call the policy gate's `guardAction` (SPEC-03) before dispatching any input; a denial shall end the step with `policy-denied` and dispatch nothing (oracle: specified).

## Dependencies

- SPEC-03 (runtime guard), SPEC-05, SPEC-27 (ports and error codes). The own-driver spike's drivers and session layer (P4 `src/drivers/`), copied with source hashes.
- Research background: independence and breadth (`12` Findings 2 and 6). Projects leaving Playwright inherited crash handling [C-R16-054].

## Milestone

M2 (design-partner alpha at its exit).

## Satisfies

FR-08, NFR-14
