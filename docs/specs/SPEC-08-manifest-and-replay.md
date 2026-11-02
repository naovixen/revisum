# SPEC-08: Manifest and replay

## Purpose

Prove determinism instead of asserting it (deterministic and hermetic, R3). It serves "our end-to-end tests are flaky, so nobody trusts a red build" (UP-02) and "we can't prove what was tested, against which spec, or by whom" (UP-08): a red build means the code changed, and every run can be reproduced and audited from its manifest.

## Scope and non-goals

- **In:** a manifest hashing every canonical input (plan, trusted project, core, adapter, engine and ACT pins, packs, redactor, Node, fonts, container digest, executable hash taken by core, fixtures, seed, clock start); `nonHermeticInputs`; determinism kit (virtual clock including timers, `performance.now`, animation frames and `crypto`, seeded random, motion off, fonts loaded); replay from a manifest comparing result hashes; a manifest-sufficiency test; a non-blocking performance benchmark on the pinned Linux image.
- **Non-goals:** cross-machine pixel identity (not claimed); manifest signing (later).

## Interfaces and types

```ts
export type RunManifest = {
  readonly schema: `${string}.manifest/v1`;
  readonly planHash: string; readonly projectHash: string;
  readonly versions: { core: string; adapter: string; engine: string; act: string; axe: string; node: string; packs: readonly string[] };
  readonly redactor: string;        // hash of the secret-redaction config and, from M3, the PII rules and mask selectors
  readonly limits: string;          // hash of run limits (timeouts, walk caps, sizes)
  readonly baselinesHash: string;   // hash of every baseline the plan reads
  readonly rulesetHash: string;     // own-engine rule set and probe configuration
  readonly executableSha256: string; readonly imageDigest: string; readonly fontsSha256: string;
  readonly seed: number; readonly clockStartMilliseconds: number;
  readonly fixtures: readonly FixtureReference[];
  readonly nonHermeticInputs: readonly string[];  // e.g. "app-server", "safari-clock"
  readonly commit: string | null;
};
// Everything a run or a replay needs from outside the core.
export type RunPorts = { readonly adapters: AdapterRegistry; readonly runner: Runner; readonly secrets: SecretStore; readonly events: EventSink };
export function manifestHash(manifest: RunManifest): string;        // sha256 of canonical JSON
export function replay(manifest: RunManifest, ports: RunPorts): Promise<{ identical: boolean; resultHash: string }>;
export type PerformanceBudget = { setupMedianMilliseconds: number; peakMemoryMegabytes: number; runs: 20; tolerancePercent: 30; blocking: false }; // Linux baseline
```

### Build notes (alignment, 2026-10-31)

AC-SPEC-32-13 and AC-SPEC-36-15 are built with this spec. Where the block above differs from the built code (`engine/src/manifest.ts`, `engine/src/run.ts`) or the committed tests, the code and tests win and the notes below say how. Marked additions are new with this spec.

- **Fields as built.** `schema` is `schemaId('run-manifest', 1)`; `seed` is `seeds.random`; `clockStartMilliseconds` is `clock.fixedTimeMilliseconds`; `versions.engine` is `engineVersion`; `versions.adapter` is `adapter`. `planHash`, `fixtures`, `nonHermeticInputs` and the built extras (`host`, `target`, `browser`, `secrets`, `storageState`, `unsafeFeatures`, `unsafeDeclarations`, `responseRewrites`, `evidence`) stay as they are.
- **New fields are optional** (addition), each absent unless its input is given, so `golden/closed-language/hashes.json`, the field lists in `test/proofs/run-guarantees.test.ts` and `test/unit/engine/clock-advance-runs.test.ts`, and AC-SPEC-35-21 all stand.
  - `executableSha256`: see AC-04.
  - `RunInputs.pins?: RunPins` (addition), gathered by `cli`'s `runPins()`; SPEC-16's `run` always passes it. It gives:
    - `versions: { core, act, axe, node, packs }`: `core` is the `cli` package version, `act` an `ACT_RULESET_VERSION` constant in `auditor-act`, `axe` `AXE_VERSION`, `node` `process.version`, `packs` sorted `name@version` (empty until SPEC-23);
    - `redactor`: sha256 of the PII patterns and mask selectors (secrets stay in `secrets`);
    - `rulesetHash`: sha256 of `auditor-act`'s rule ids and probe settings;
    - `baselinesHash`: sha256 of the sorted `{ path, sha256 }` of the baselines the plan reads (the empty list's hash while plan 1.3 reads none);
    - `imageDigest`: the run image id from `.revisum-run-image.json`; a host run has none and lists `run-image` in `nonHermeticInputs`;
    - `fontsSha256`: sha256 of each system font file's path and content hash, sorted, computed once per process;
    - `commit`: `git rev-parse HEAD`, or null outside a checkout.
  - With `pins`, the engine also adds `projectHash` (the canonical project without `evidenceMode` and `planner`, which a plan run never reads, so AC-SPEC-35-21 holds) and `limits` (sha256 of `project.limits`).
- **Ports.** `RunPorts` keeps its built shape in `engine/src/run.ts`: `adapters` is `drivers` (a registry through `adapterRegistry`); `secrets` and `events` exist beside `audit`, `clock`, `artifacts` and `redactor`; `services` and `databaseCommands` are SPEC-32's and SPEC-36's. The isolated runner wraps a run from outside (SPEC-07), so it is not a port.
- **Replay** lives in `engine/src/replay/replay.ts`, pure apart from calling `run`: `replay(request: ReplayRequest, ports: ReplayPorts): Promise<Result<ReplayOutcome, ReplayError>>`.
  - `ReplayRequest = { manifest: unknown; recording: unknown | null; recordedResultHash: string; inputs: Omit<RunInputs, 'seed' | 'fixedTimeMilliseconds' | 'fixtures'> }`. Seed, clock start and fixtures come from the manifest. The plan is parsed and gated as for a run; it must hash to `planHash` and `targetId` must be `target.id`, or the replay ends `replay-mismatch`.
  - `ReplayPorts = Omit<RunPorts, 'services' | 'databaseCommands'> & { fixtures: { read(path: string): Promise<Uint8Array | null> } }`, so a replay can't be given a live caller.
  - The result hash is `RunResult.resultHash` (`withResultHash`: sha256 of the result's canonical JSON without `timings` and the manifest body, `manifestHash` included).
  - `ReplayOutcome = { identical, resultHash, manifestHash, differingInputs, verdict }`. `differingInputs` lists the top-level manifest fields whose canonical JSON differs. `verdict` is `identical`, `per-environment-baseline` (only `host`, `browser`, `executableSha256`, `imageDigest`, `fontsSha256` or `versions` differ) or `mismatch`. Neither of the last two is a pass; SPEC-16's `replay` command reports both as `replay-mismatch`.
  - `replayManifest(manifest)` stays as `replay`'s first check, since `test/unit/cli/suite-runs.test.ts` calls it.
- **Recorded replies, opt-in** (AC-SPEC-32-13, AC-SPEC-36-15; founder, 2026-10-31: `docs/decisions/replay-recordings.md`). The result keeps only hashes, so replies are recorded separately, and only when the trusted project sets `replay: { recordReplies: true }` (addition). Recordings hold response bodies and command output, which may carry personal data until SPEC-09 masks them.
  - Without the setting, a run with calls or commands writes no recording, and `replayManifest` and `replay` refuse it with `replay-not-claimed`.
  - With it, `recordingPorts({ services, databaseCommands })` (engine, addition) wraps the run's ports and keeps each reply in order with its request's sha256 (a `Secret` counts by name only). It makes a `RunRecording` (`schemaId('run-recording', 1)`): the manifest hash, which ports were wired, each call's status, media type and body, each command's exit code, `timedOut`, stdout and `truncated`, and a failed reply as its code. Stderr and egress events are dropped; the engine reads neither.
  - Bodies are UTF-8 text, or base64 when not text. Each echo of a run secret, in any form the leak scanner looks for, is cut out and kept as `{ offset, secretName, form }`; the replay puts it back from its own `SecretStore`.
  - `cli` writes it beside the result as `<run id>.recording.json`. No exporter, report or PR comment reads it.
  - `replayedServices(recording)` and `replayedDatabaseCommands(recording)` (engine, addition) are wired exactly where the recorded run had ports, and send nothing. A request whose hash differs, one after the last recorded reply, a reply never used, or a missing recording ends the replay `replay-mismatch { kind: 'service-call' | 'database-command', position }`.
  - `service-calls` and `database-commands` stay in `nonHermeticInputs`; with a recording neither blocks a replay.
- **Where the tests run.** In `test/replay/` (`npm run replay`, inside `check`); `check:linux` and CI run them in the pinned image, which is what AC-01 and AC-06 claim.
  - AC-01: `fixtures/signup-app` through `test/support/signup-harness.ts` on `cdp-chromium-headless-shell`: one run, then 20 replays, each `identical`.
  - AC-06: `golden/replay/windows-signup/` holds a manifest and result hash made on Windows (a tests commit). Replayed on Linux it gives `identical: false`, `host` in `differingInputs` and `per-environment-baseline`; never a pass unless the hashes match.
  - AC-SPEC-32-13 and AC-SPEC-36-15 use the recording driver and fake ports from `test/unit/engine`, 20 replays each, with a spy showing nothing was sent or run. The real container path stays in `check:containers`.
- **AC-02.** `test/unit/engine/manifest-perturbation.test.ts` has one perturbation per field, typed `{ readonly [Field in keyof Required<RunManifest>]: Perturbation }`, with the same pattern over `versions`, `seeds` and `clock`. Because of `Required`, a new optional field without a case fails the type check; a guarantee file shows it with `@ts-expect-error`. Each case changes the input feeding its field, from a fully populated manifest, and the hash or `nonHermeticInputs` must change.
- **AC-03.** No built adapter needs it today: CDP pins `target.timezone` and run the determinism kit. A future adapter lists `clock`, `time-zone` or `randomness` in `AdapterInfo.cannotPin`; the test uses a stub driver. `GuaranteeLossReason` gains `determinism-unpinned` on `replay-identical` (addition), and `replayManifest` and `replay` refuse with `replay-not-claimed`.
- **Determinism kit.** The scope lists `crypto`: `determinismScript` (`contracts/src/determinism.ts`) gains seeded `crypto.getRandomValues` and `crypto.randomUUID` from the same generator. `crypto.subtle` is left alone.
- **AC-04.** `openSession` hashes the executable with SPEC-05's `hashExecutable` whenever the adapter has `build`, with or without a lockfile, before `open`; `checkPinnedBuild` becomes one function that hashes, then compares with the lock entry if there is one. A failed hash ends the run `TargetUnavailable`: core never launches what it could not hash. `browser.version` stays a label only. Playwright launches its own browser and has no `build`; its runs record no hash and, with a lockfile, list `browser-build` as before (SPEC-05).
- **AC-05.** `tools/benchmark.ts` (`npm run benchmark`) runs the sign-up plan 20 times on `cdp-chromium-headless-shell`. Setup time runs from calling `run` to the first `step.start`; peak memory is the highest combined RSS of Node and Chromium, sampled from `/proc` every 100 ms. Medians are compared with `docs/decisions/benchmark-baseline.json` (`linux-x64`; placeholder values until the first weekly run). A regression over 30% prints a `::warning::` alarm and a job-summary line; the tool always exits 0. On `arm64` it records results with no comparison.
  - To keep CI minutes down (main session, 2026-10-31), it runs in its own workflow, on a weekly schedule and on manual dispatch, in the pinned image; never on each push, and outside `check`, `gates` and the guarantee map. ARM results are recorded only when someone runs it on an arm64 machine: no paid runner. `test/proofs/benchmark.test.ts` checks the tool and the workflow, as the browser-upkeep proof does.
- **AC-07 and AC-08**, checked before any driver call. `decodeManifest` refuses with `version-unsupported` when the schema is not `revisum.run-manifest/v1` or a key is unknown; the recording is checked the same way. A fixture missing or with a different sha256 gives `{ code: 'replay-mismatch', fixture: path }`; a known field of the wrong shape gives `replay-mismatch` with its JSON path.
- **Error codes.** `ReplayErrorCode` becomes `'replay-not-claimed' | 'replay-mismatch' | 'version-unsupported'`. `docs/errors.md` gains `## version-unsupported`, apart from the plan error `version_unsupported`; the `replay-mismatch` entry widens to input mismatches. A `replay` union joins the pinned lists in `test/proofs/error-code-exhaustiveness.ts` and `test/proofs/error-anchors.test.ts` under the standing exception.

- **Settled with the tests** (2026-11-01, commit 3c6bfdf).
  - A run that recorded its replies says so by listing `recorded-replies` in `nonHermeticInputs` (addition). A separate manifest field isn't possible: the perturbation table has no case for one, so it would fail to compile, which is that test's purpose. `replayManifest(manifest)` refuses a manifest listing `service-calls` or `database-commands` without `recorded-replies`, with `replay-not-claimed`.
  - Writing `<run id>.recording.json`, and writing none without the setting, is `cli`'s job and is built and tested with SPEC-16's `run`; here only the recording ports and the refusal are built and tested.
  - The shapes the tests assume, in the header of `test/unit/engine/replay-examples.ts`, stand: `recordingPorts` returns the wrapped ports and `recording(manifestHash)`; a recording has a `schema`; an unused reply's position is the count of replies used; matching inputs with another result hash give `mismatch`; `tools/benchmark.ts` takes `--samples` and `--baseline`.
  - AC-06's golden is a `playwright-chromium` run, which has no `executableSha256`. It is remade on Windows, as its README says, whenever the engine version, the adapter or the result's shape changes. Changed by the founder, 2026-11-02: the Playwright adapter is removed, so the golden must be remade on the CDP driver; until then the replay test may fail against it.

## Acceptance criteria

- AC-SPEC-08-01: When the same manifest is replayed 20 times in the pinned Linux image, every result hash shall be identical (oracle: regression; extends AC-p4-18 and AC-p7-33).
- AC-SPEC-08-02: When each field of `RunManifest` is perturbed in turn, enumerated from the type so that a new field without a perturbation case fails to compile, the manifest hash or a `nonHermeticInputs` entry shall change (oracle: metamorphic).
- AC-SPEC-08-03: When a target's adapter cannot pin the clock, time zone or randomness, those inputs shall appear in `nonHermeticInputs` and the run shall not be replay-claimed (oracle: specified; the own-driver spike's WebDriver classic result, P4).
- AC-SPEC-08-04: When core launches a browser, it shall hash the executable it launched and record it, rather than trusting a reported version (oracle: specified).
- AC-SPEC-08-05: When the benchmark runs, it shall take 20 runs in the pinned Linux image and compare median setup time and peak memory with the stored Linux baseline; a regression over 30% shall raise a non-blocking trend alarm and never fail a gate. ARM results are recorded with no pass or fail (oracle: regression).
- AC-SPEC-08-06: When a manifest produced on Windows is replayed in the Linux image, the result shall state whether hashes match, and a mismatch shall be reported as per-environment baselines, not a pass (oracle: specified).
- AC-SPEC-08-07: When a replay names a fixture that is missing or whose hash differs, replay shall end `replay-mismatch` naming the fixture, never a pass (oracle: specified).
- AC-SPEC-08-08: When a manifest's schema version is newer or unknown, replay shall refuse it with `version-unsupported` (oracle: specified).

## Dependencies

- SPEC-04 (redactor hash), SPEC-05 to SPEC-07. The core skeleton's manifest, determinism and seeded-random modules (spike P3 `manifest.ts`, `determinism.ts`, `random.ts`).
- Research background: architecture (`04` Findings 2 and 9); stack and cost (`06`, performance).

## Milestone

M2.

## Satisfies

FR-09, NFR-01, NFR-02
