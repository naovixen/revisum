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

### Build notes (alignment with the seeded code, 2026-10-29)

The seeded `contracts` code and the tests built on it win where they differ from the block above. Marked additions are new with this spec.

- **`Unavailable` keeps its seeded shape** `{ reason, detail }`; tests build it that way. The run result already carries `targetId`, so the field above is dropped. `UnavailableReason` gains `provider-unavailable` and `build-mismatch` (addition).
- **`Target` keeps its seeded fields.** `device` stays the closed `DeviceProfileId` set; "phone profile" means `phone-390`, "desktop" `desktop-1280`.
- **New `Target` fields are optional** (addition): `kind`, `version`, `fidelity`, `provider`, `required`, `vendorExtensions`. The project parser sets each only when the project file gives it, so existing manifests and replay hashes don't change. Code reads them through engine helpers with these defaults: `kind` `browser`; `version` the adapter's own build, pinned by the lockfile; `provider` `local`; `required` `true`; `fidelity` `engine` on a desktop or laptop profile, `engine-emulated` on a tablet or phone profile. Keys in `vendorExtensions` must be `vendor:name`; any other key is rejected with its JSON path. Every value is checked against its closed set.
- **`AdapterRegistry`** is built from the run context's `drivers` map by an engine function `adapterRegistry(drivers)`; `find` returns `null` for an unregistered id.
- **Resolution** follows research `05` §2 in this order: (1) not in the matrix: `not-declared`; (2) adapter not registered: `adapter-not-registered`, no fallback; (3) `supports(target)` refuses: `engine-not-supported` or `device-not-supported`, and no other adapter is tried; (4) lock entry present and the build's hash differs: `build-mismatch`; (5) launch or provider failure: `launch-failed` or `provider-unavailable`; (6) retries use the same target only; (7) required versus optional, below; (8) `testedOn` wording; (9) `nonHermeticInputs`.
- **Builds** (addition to `BrowserDriver`, optional so existing test drivers stay valid): `build?(target): Promise<Result<BrowserBuild, BuildFailure>>`, where `BrowserBuild = { version, executablePath }` and `BuildFailure = { code: 'lock-download-failed' | 'lock-offline' | UnavailableReason; detail }`. An adapter without `build` can't pin its browser, so its runs list `browser-build` under `nonHermeticInputs` when a lockfile is in use.
- **Lockfile** `targets.lock.json` beside `project.json`: `{ schema, entries: LockEntry[] }`, entries sorted by target id, canonical JSON with a final newline. A hand-written engine decoder parses it; unknown keys are rejected.
  - `lock(project, registry, previous)` returns `Result<readonly LockEntry[], LockFailure>`, `LockFailure = { targetId, code: 'lock-download-failed' | 'lock-offline' | 'build-mismatch' | UnavailableReason, detail }`. A previous entry with the same version and a different hash fails with `build-mismatch` (AC-08).
  - `lockToFile(folder, project, registry)` reads the existing file, calls `lock`, and writes (temporary file, then rename) only on success, so any failure leaves the file byte-identical (AC-07).
  - At run time, a run given lock entries hashes the adapter's build before `open`; a different hash ends the run `TargetUnavailable` with `build-mismatch` and opens no browser. A run given no lock entries behaves as before.
- **Required and optional targets** (AC-05). `ExitCode` and `EXIT_PRECEDENCE` move into `contracts` now, exactly as SPEC-11 declares them (addition taken early). An engine function `unavailableTargetOutcome(target)` returns `{ exitCode: 3 }` for a required target and `{ exitCode: 0, skipped: true, warning }` for an optional one. SPEC-11's JUnit exporter and SPEC-16's CLI consume it; this spec tests the function.
- **`testedOn(target, build?)`** lives in `engine` and is pure. It names the engine and, when known, the major version, then the device profile, then the fidelity in brackets when it isn't `engine`, such as "Chromium 156, phone viewport (emulated)". WebKit always reads "patched WebKit, not Safari". It never contains "Safari" otherwise, "Android", "iPhone" or "iOS".
- **`nonHermeticInputs`**: `AdapterInfo` gains an optional `cannotPin?: readonly string[]` (addition), merged into the manifest's existing list only when non-empty, so other manifests keep their hashes.
- **Not yet wired:** the `lock` CLI command (SPEC-16) and real browser downloads. `driver-cdp`'s `build` locates the Chrome for Testing build that `tools/install-browsers.ts` installs and reports `lock-download-failed` when it is missing; downloading at lock time would need `@puppeteer/browsers` at run time and a dependency review first.
- **Risk:** `targets.lock.json` is not yet a trusted file (SPEC-02). A changed lockfile can only refuse a run or pin a hash that must still match the executable on the machine. Revisit at the M2 exit review.

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
