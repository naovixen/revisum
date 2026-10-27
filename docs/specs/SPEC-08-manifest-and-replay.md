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
