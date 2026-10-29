# Velocity

Actual time per spec, for the velocity kill criteria in `E:\core\docs\09-mvp-plan.md` §6. The plan's day 0 is 2026-11-02 (beta on day 235, about 2027-06-25).

| Spec | Milestone | Started | Committed | Days | Notes |
|---|---|---|---|---|---|
| SPEC-00 (seed) | M0 | 2026-10-27 | 2026-10-28 | 2 | Seed and build gates; remaining criteria queued in `START.md` |
| SPEC-27 | M1 | 2026-10-28 | 2026-10-28 | 1 | One test-helper fix approved by the founder (ES module scratch folder) |
| SPEC-01 | M1 | 2026-10-28 | 2026-10-28 | 1 | Founder decisions: test plans moved to v1.1; standing rule for pinning declared error codes. Coverage-study data gathered separately |
| SPEC-02 | M1 | 2026-10-28 | 2026-10-28 | 1 | Two safe-side gaps noted for the M1 exit review |
| SPEC-03 | M1 | 2026-10-28 | 2026-10-28 | 1 | Founder decisions: delete allowance, production opt-in, gate step in test helpers |
| SPEC-04 | M1 | 2026-10-28 | 2026-10-28 | 1 | Two test faults fixed with founder approval; Firefox replay flaked once under load |
| SPEC-30 (M1 parts) | M1 | 2026-10-28 | 2026-10-28 | 1 | Founder asked for one literal-step module instead of scattered checks |
| SPEC-31 (parser parts) | M1 | 2026-10-28 | 2026-10-28 | 1 | One contradictory test case fixed with founder approval |
| SPEC-32 (M1 parts) | M1 | 2026-10-28 | 2026-10-28 | 1 | Founder: one body shape with opaque secrets; seven test faults fixed with approval |
| SPEC-33 (grammar) | M1 | 2026-10-28 | 2026-10-28 | 1 | Full check flaked twice under load (ACT connection drop, CDP screenshot hash); green on third run |
| SPEC-34 (parser parts) | M1 | 2026-10-28 | 2026-10-28 | 1 | One test case fixed with founder approval |
| SPEC-28 (M1 parts) | M1 | 2026-10-28 | 2026-10-28 | 1 | Readable form for plan 1.2 added; commit waited for the browser-failure fix |
| Browser failures | M1 | 2026-10-28 | 2026-10-28 | 1 | Root cause: Chromium port randomisation on Windows; checks now about 5.5 minutes |
| SPEC-35 (M1 parts) | M1 | 2026-10-28 | 2026-10-28 | 1 | Green first run; two runner rules noted for M2 |
| SPEC-36 (M1 parts) | M1 | 2026-10-29 | 2026-10-29 | 1 | Plan 1.3 opened; version tests made version-agnostic |
| SPEC-28 (1.3 readable forms) | M1 | 2026-10-29 | 2026-10-29 | 1 | Founder approved flipping the no-readable-form test; green first run |
| SPEC-00 (remaining criteria) | M1 | 2026-10-29 | 2026-10-29 | 1 | Founder chose pending guarantee rows; trailers checked from 8165795; merged seed sources kept; green on Linux |
| Port randomisation contract test | M1 | 2026-10-29 | 2026-10-29 | 1 | Reads the real command line; green on Windows and Linux |
| M1 exit | M1 | 2026-10-29 | 2026-10-29 | 1 | Reviews of SPEC-02, 03, 04 found trust-path gaps, all fixed; green on Windows and Linux |
| SPEC-05 | M2 | 2026-10-29 | 2026-10-29 | 1 | Aligned with seeded contracts (optional target fields keep replay hashes); lock CLI and downloads wait for SPEC-16; green on Windows and Linux |
| SPEC-06 | M2 | 2026-10-29 | 2026-10-29 | 1 | Guard stays optional on act (seeded tests); three driver codes pinned under the standing exception; Linux zygote leak on close fixed; green on Windows and Linux. Weekly upkeep workflow not yet run on GitHub |
