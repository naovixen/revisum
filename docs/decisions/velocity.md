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
| SPEC-07 | M2 | 2026-10-29 | 2026-10-29 | 1 | Founder chose real-container tests on the host and one CI step, and chroot in the seccomp profile; check:containers 22/22 on Windows; green on Windows, Linux and GitHub CI (container step included, 2026-10-29) |
| SPEC-35 workload runner | M2 | 2026-10-29 | 2026-10-30 | 2 | Founder approved two test fixes (bare ".." entry, port 9); secrets kept off the Docker command line; fixture suite uses a stand-in for Playwright Test (not in the lockfile); setup runs in its own read-only container. check:containers 47/47; green on Linux; one Windows Firefox screenshot-replay failure while Docker Desktop was starting, passed twice on rerun: watch it |
| SPEC-30 driver parts | M2 | 2026-10-30 | 2026-10-30 | 1 | Drivers declare the features they perform, so the old refusal test stays unchanged; founder approved a canary fix; empty 404 pages no longer fail navigation; green on Windows and Linux |
| SPEC-31 driver parts | M2 | 2026-10-30 | 2026-10-30 | 1 | Same capability model; founder approved a fixture comment fix; downloads stored under generated names in a per-run folder, no file text kept until SPEC-09; green on Windows and Linux |
| SPEC-32 real caller | M2 | 2026-10-30 | 2026-10-30 | 1 | Through the egress proxy; proxy marks its own answers with x-egress-decision; HTTPS tunnel path untested; check:containers 47/47; green on Windows and Linux. Found 6 containers and 3 networks left by an interrupted container run this morning, removed: the runner should sweep stale revisum-run-* items at start |
| SPEC-33 driver parts | M2 | 2026-10-30 | 2026-10-30 | 1 | Same capability model; stubs answer fetch and XHR only; founder approved a test-helper fix for reused Windows parent ids (Docker Desktop seen as a browser child); green on Windows and Linux, flaky rate 0 |
| SPEC-34 driver parts | M2 | 2026-10-30 | 2026-10-31 | 1 | Same capability model; timers virtual only in plans that advance; performance.now() now frozen in every plan. A helper's probe launched headed Chrome (empty flag list) and overwrote the founder's clipboard once; the launcher now always adds headless and muted audio. The Linux half of AC-16 skips (no Xvfb or xclip in the image). Timer counter-example relies on real time, 20/20 on Windows: watch it. Fixed CI's container step (workload output folders under the image's /tmp). Green on Windows; Linux green before the launcher fix |
| SPEC-36 page parts | M2 | 2026-10-31 | 2026-10-31 | 1 | Same capability model; both drivers declare structuralLocators, domChecks and pageScripts. The engine decodes script results itself (size, depth 64) and keeps only declared fields and a sha256. Untested: a script inside an iframe on CDP; a script in an endless loop times out but blocks its page until the session closes. Alignment commit 2a1df21 lacks the Agent version, listed as malformed. Green on Windows and Linux |
| SPEC-36 database commands | M2 | 2026-10-31 | 2026-10-31 | 1 | DatabaseCommandRunner port in RunPorts, wired by cli to the workload runner; the proxy container relays one TCP port per allowed service and the workload maps the service's name to it. Founder approved one test fix: a raw address can't be relayed without network-admin rights, so commands reach a service by name. A line break never reaches a command (value-unsafe, stricter than AC-12). Replay (AC-15) with SPEC-08. check:containers 67/67; green on Windows and Linux |
| SPEC-28 draft and planner adapters | M2 | 2026-10-31 | 2026-10-31 | 1 | New DraftPlanner port (AiPlanner kept for committed tests). Endpoint read from the protected branch; customer keys over HTTPS only; calls go through runner's service caller behind a proxy allowing only the planner, so the reveal allow-list is unchanged. admitCoreDraft added for core-recorded drafts. A test-only TLS private key sits in fixtures/draft-command/planner-tls. A helper was stopped by accident and a fresh one finished its work. Green on Windows and Linux |
