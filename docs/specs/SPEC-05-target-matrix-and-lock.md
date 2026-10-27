# SPEC-05: Target matrix and lock

## Purpose

Users name exactly what to test with, and core runs that or says why it can't (user-chosen targets, R5). It serves "we're asked whether it works on Safari or a phone, and can't honestly say" (UP-07): reports state what was really tested, never a silent stand-in.

## Scope and non-goals

- **In:** `Target` with `kind`, `adapter`, `engine`, `version`, `device`, `fidelity`, `provider`, `locale`, `timezone`, `colorScheme`, `reducedMotion`, `required` and vendor-namespaced `vendorExtensions`; the nine target-resolution rules (research `05` Finding 2); `core lock` writing a lockfile of exact builds and executable hashes; "tested on" wording as a function of fidelity; `nonHermeticInputs` for adapters that can't pin.
- **Non-goals:** cloud farm and device-bridge providers (SPEC-25); automatic upgrade of browsers.

## Interfaces and types

```ts
// TargetId and Locale are shared core types; see SPEC-27.
export type Fidelity = 'engine' | 'engine-emulated' | 'emulator' | 'simulator' | 'real';
export type Engine = 'chromium' | 'firefox' | 'webkit';
export type AdapterId = Brand<string, 'AdapterId'>;                // e.g. "cdp", "bidi"
export type DeviceProfileId = Brand<string, 'DeviceProfileId'>;    // a named viewport and input profile, e.g. "phone"
export type TimeZone = Brand<string, 'TimeZone'>;                  // IANA time-zone name, e.g. "Europe/London"
export type Target = {
  readonly id: TargetId; readonly kind: 'browser' | 'mobile-web' | 'native-app' | 'desktop';
  readonly adapter: AdapterId; readonly engine: Engine; readonly version: string;
  readonly device: DeviceProfileId | string; readonly fidelity: Fidelity;
  readonly provider: 'local' | 'emulator' | 'cloud' | 'bridge';
  readonly locale: Locale; readonly timezone: TimeZone;
  readonly colorScheme: 'light' | 'dark'; readonly reducedMotion: 'reduce' | 'no-preference';
  readonly required: boolean; readonly vendorExtensions?: Readonly<Record<`${string}:${string}`, unknown>>;
};
export type UnavailableReason =
  | 'not-declared' | 'adapter-not-registered' | 'engine-not-supported'
  | 'device-not-supported' | 'launch-failed' | 'provider-unavailable' | 'build-mismatch';
export type Unavailable = { readonly targetId: TargetId; readonly reason: UnavailableReason; readonly detail: string };
export interface AdapterRegistry { all(): readonly BrowserDriver[]; find(id: AdapterId): BrowserDriver | null }
export type LockEntry = { targetId: TargetId; version: string; executableSha256: string };
export function lock(project: TrustedProject, registry: AdapterRegistry): Promise<readonly LockEntry[]>;
export function testedOn(target: Target): string; // e.g. "Chromium 156, phone viewport (emulated)"
```

## Acceptance criteria

- AC-SPEC-05-01: When a plan names a target that is not in the matrix, the run shall end `TargetUnavailable` with `not-declared` (oracle: specified).
- AC-SPEC-05-02: When a target asks for WebKit and no registered adapter supports it, every adapter shall return `engine-not-supported` and no substitute shall run (oracle: specified; reuses AC-p4-19).
- AC-SPEC-05-03: When a Firefox target names a phone profile, core shall return `device-not-supported` rather than run on desktop (oracle: specified; behaviour of the core skeleton and own-driver spikes, P3 and P4).
- AC-SPEC-05-04: When the browser build at run time differs from the lockfile hash, the target shall be unavailable with `build-mismatch` (oracle: specified).
- AC-SPEC-05-05: When a required target is unavailable, the CLI shall exit 3; when an optional one is, JUnit shall mark it skipped and the run shall warn (oracle: specified).
- AC-SPEC-05-06: When a report names a target, its wording shall come from `testedOn` and shall never say "Android phone" or "Safari" for an engine-emulated or patched-engine target (oracle: specified).
- AC-SPEC-05-07: When `core lock` can't download a build or runs offline, it shall exit with `lock-download-failed` or `lock-offline`, leave the existing lockfile byte-identical, and name the target (oracle: specified).
- AC-SPEC-05-08: When a re-lock downloads the same version with a different executable hash, `lock` shall refuse to write the entry and report `build-mismatch` (oracle: specified).

## Dependencies

- SPEC-01, SPEC-02. The core skeleton's target module (spike P3 `target.ts`).
- Research background: API and integration (`05` Finding 2). Playwright's WebKit is not Safari [C-R01-021].

## Milestone

M2.

## Satisfies

FR-07
