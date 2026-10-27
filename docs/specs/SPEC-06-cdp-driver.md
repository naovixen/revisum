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
