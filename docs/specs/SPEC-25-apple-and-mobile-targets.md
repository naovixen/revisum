# SPEC-25: Apple and mobile targets

## Purpose

Reach Safari, iOS and Android honestly, on rented or customer hardware, with every non-hermetic input declared. It serves "we're asked whether it works on Safari or a phone, and can't honestly say" (UP-07): "does it work on an iPhone?" gets a real, labelled answer.

## Scope and non-goals

- **In:** Safari on macOS and iOS over WebDriver classic, declared non-hermetic; iOS native through WebDriverAgent spoken directly; Android Chrome and native through chromedriver and UiAutomator2 on emulators with KVM; cloud farms and customer device bridges through vendor-namespaced capabilities (`vendorExtensions`); the contract suite run on a rented Mac before any Safari or iOS claim.
- **Non-goals:** an Appium server dependency; a device lab of core's own; replay claims for classic, farm or bridge targets.

## Interfaces and types

```ts
export type MobileAdapterId = 'webdriver-classic' | 'webdriver-agent' | 'uiautomator2' | 'chromedriver';
export type ProviderConfig =
  | { provider: 'emulator'; androidVirtualDevice: string }
  | { provider: 'cloud'; vendorExtensions: Readonly<Record<`${string}:${string}`, unknown>> }
  | { provider: 'bridge'; endpoint: Origin };
```

## Acceptance criteria

- AC-SPEC-25-01: When the contract suite runs on safaridriver and WebDriverAgent on a rented Mac, results shall be recorded per test, and Safari or iOS shall be claimed only for tests that pass (oracle: specified).
- AC-SPEC-25-02: When a classic, farm or bridge target runs, the manifest shall list its non-hermetic inputs and the report shall make no replay claim (oracle: specified; reuses the own-driver spike's measured WebDriver classic limits, AC-p4-06).
- AC-SPEC-25-03: When the contract suite runs on an Android emulator in Linux CI, results shall be recorded per test (oracle: specified).
- AC-SPEC-25-04: When a mobile adapter needs a port method the `Session` seam lacks, the change shall be a recorded port revision, not an adapter-only workaround (oracle: specified).

## Dependencies

- SPEC-05, SPEC-19.
- Research background: API and integration (`05` Finding 5); independence and breadth (`12` Finding 2). iOS can't be virtualised off Apple hardware [C-R01-015].

## Milestone

Phase 3, on a named customer request.

## Satisfies

FR-38
