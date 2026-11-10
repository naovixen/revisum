# Milestone exits

One section per milestone exit: what `docs/system-design.md` §7 asked for, the trust-path reviews, and the kill criteria in `E:\core\docs\09-mvp-plan.md` §6.

## M1, language and trust (2026-10-29)

### In short

- M1's slice is met: plans in readable or JSON form parse, gate and need a person's approval.
- Cold reviews of SPEC-02, 03 and 04 found real gaps on the trust path. All are fixed through the tests-then-code loop and `npm run check` is green; `npm run check:linux` is green on the final tree.
- The language-fit kill criterion cannot be met by its date (2026-11-23) on any measure taken. The founder recorded the evidence-mode pivot as its response, so the build continues until it is demoable.

### Decisions

| Decision | By |
|---|---|
| Flip the committed `no-readable-form` test so unsafe plans have readable text | Founder, 2026-10-29 |
| Guarantee rows whose tests come with later specs are pending until those specs are ticked | Founder, 2026-10-29 |
| The run's audit sink is required; 23 test files gained a sink | Founder, 2026-10-29 |
| A code-owner approval binds the plan hash to the reviewed commit's bytes and verifies before merge | Founder, 2026-10-29 |
| The product name leaves bot logins and temp-folder prefixes | Founder, 2026-10-29 |
| Four commits with a multi-spec `Spec:` trailer are listed in `KNOWN_MALFORMED_COMMITS` | SPEC-00 build notes |
| The evidence-mode pivot resolves the language-fit signal; the build goes on until it is demoable, then the founder judges from use | Founder, 2026-10-29 |

### Findings

**§7 slice.** Parse: SPEC-01, 28, 30 to 34 and 36 (plan 1.3 with readable forms). Gate: SPEC-03, with SPEC-36's rules. Approval: SPEC-02, lock-down route declared, code-owner route verified. The pivot's SPEC-35 and SPEC-36 slices are now in §7 (`892d0fe`).

**Reviews, fixed** (tests `ad94078`, `d9ede7e`, `25ab503`, `d2f2afb`; code `4f0473c`, `8c5e423`):

| Spec | Gap | Fix |
|---|---|---|
| SPEC-02 | Code-owner route approved any hash | Hash bound to bytes at the reviewed commit; stale or mismatched refused |
| SPEC-02 | A run accepted another plan's standing | Lent standing is ignored; plan runs as a proposal |
| SPEC-02 | Deny rules judged on one sample command | Whole action family must be denied |
| SPEC-02 | Strength lint missed switch, alias, intersection | Caught |
| SPEC-03 | Irreversible dialogs failed as unsupported, never Denied | Dialogs reach the guard |
| SPEC-03 | `Authorised` forgeable at compile time | Unexported symbol brand |
| SPEC-03 | A denial could leave no record | Audit sink required; failed write marks it unrecorded |
| SPEC-03 | No targets meant no patterns; authorisation shared across projects | Built-in patterns apply; authorisation bound to its project |
| SPEC-03 | camelCase, soft-hyphen, full-width labels missed | NFKC, format characters removed, camelCase split |
| SPEC-04 | Short secrets visible in observed values | Secret-filled fields and exact short-secret observations redacted |
| SPEC-04 | Short base64 echoes at offsets 1 and 2, form and lower-case URL encoding missed | Caught at every alignment and encoding |
| SPEC-04 | Reveal lint missed destructuring and dynamic import | Caught |
| SPEC-04 | `authToken`, `client_secret` not sensitive | Names split into words |
| SPEC-04 | Storage state silently ignored | `unsupported-step` until a driver loads it |

**Carried to M2 (SPEC-06):** real drivers ignore the guard and refuse dialogs; `Session.act`'s guard becomes required; storage state loading.

**Kill criteria, as of 2026-10-29:**

| Signal | Status |
|---|---|
| Language fit, 70% by 2026-11-23 | Unmet: 36% fresh on plan 1.2 without escape hatches; 44% fresh on 1.3 even counting unsafe features. Resolved by the founder: the pivot (`language-fit-pivot.md`) is the response, so it no longer stops the build |
| Velocity, M1 by 2027-01-06 | Met on this exit, once pushed |
| Problem fit, 5 of 15 calls by 2027-01-25 | No calls recorded yet; not due |
| Driver parity, upkeep, M3 velocity | Not due; M2 or later |

### Risks

- **Language fit is resolved, not met.** Plans alone express under half of tests, so the product's value rests on evidence mode (M2 runner, M3 report) reaching a demo.
- Irreversible-name patterns are English-first and whole-word; French "Supprimez" or "Confirm payment" are not matched. Adding words changes SPEC-03's lists.
- camelCase splitting makes names like "PayPal" match "pay" (safe side; projects can allow names).
- `fileAtCommit` is optional on the version-control port, since two committed test helpers build the port without it; a port lacking it refuses code-owner reviews. No test yet covers it being unavailable.
- Branch protection waits for beta; until then the founder's push is the only gate.

## M2, driver and isolation (2026-11-01)

### In short

- M2's specs are built, and the plan's three exit tests pass on the pinned Linux image. One part of §7's slice is proved only in pieces: no test runs a plan in the container and then replays that run (see the §7 slice below).
- The cold review of SPEC-07 found 14 gaps, 3 of them high, and its new tests found a real hole: the run container could reach the Docker host through its network's gateway, so `isolated` overclaimed. All are fixed.
- The isolation kill criterion is passing: CI's container step passed 105 of 105 on `55a0b5a`, with the gateway fix in.

### Decisions

| Decision | By |
|---|---|
| Recordings of service and command replies are opt-in (`replay-recordings.md`) | Founder, 2026-10-31 |
| Fix the committed test helper that replayed the real manifest in its `null` case (`0399830`) | Founder, 2026-11-01 |
| On Linux, the `host.docker.internal` tests use the service on the Docker host's own network, as CI's test process runs in a container (`27312b3`) | Founder, 2026-11-01 |
| The benchmark runs weekly and on manual dispatch, outside `check`; ARM results only if someone runs it on an arm64 machine, with no paid runner | Main session, 2026-10-31 |
| Internal networks are created without a gateway, and the probe tries where it would be, so a Docker that keeps it gives `host` | Main session, 2026-11-01 |
| An isolated plan with service calls and no recording loses `replay-identical`, with the reason `replies-not-recorded` | Main session, 2026-11-01 |
| A refused or failed `--after` login gets its own error code, `after-plan-failed`, with SPEC-16 (AC-SPEC-16-13); it stays `plan-rejected` until then | Founder, 2026-11-01 |
| Joining the isolated path waits for SPEC-16 (AC-SPEC-16-11 and 12) rather than being done before M3 | Founder, 2026-11-01 |

### Findings

**Checks on the final code (`da4a7c8`):** each ran alone, one after another.

| Check | Result |
|---|---|
| `npm run check`, Windows | 0 failures; 1 skip (`test` 3501 and 664, `proofs` 407 and 82, `replay` 1 and 5) |
| `npm run check:containers`, Docker Desktop | 105 of 105 |
| `npm run check:linux`, pinned image | 0 failures; 4 skips (same counts; 3 of the skips are in `proofs`) |

The skips are `test/browser/element-state/DomChecks.test.ts:62` (a driver without `rememberedValues`) and, on Linux, the three clipboard-proof tests that need xclip.

**§7 slice.**

| Asked for | Status |
|---|---|
| A plan runs in the container, egress blocked | Met through a test-set script (`test/containers/`). The real `run` wiring is SPEC-16's |
| Replay matches | Met on the pinned image: the sign-up plan on the headless shell, 20 replays, identical. **Not joined up:** an isolated replay is tested with fake ports only, and no test in `test/containers/` replays a run made in the container. SPEC-16's `run` is the first place to close this |
| Workload runner: suite with egress, traces and manifest | Met; `check:containers` |
| SPEC-36's driver parts, then database commands | Met; commands reach a service by name only |
| `draft` and `draft --explore` | Met; the crawl runs in the container, and the page map matches the host's golden map apart from origin and level |

**Plan's exit tests (`09` M2).**

| Test | Status |
|---|---|
| Capability contract tests pass in 20 repeated Linux runs | Met: iframes, dialogs, uploads and a crashed tab each ran 20 times in the pinned image |
| WebSocket, worker, popup, redirect and beacon egress blocked | Met with a real browser and the real proxy running in-process. In a real container, only page, WebSocket, beacon and raw-socket traffic are tested. Worker, popup and redirect are not. The proxy-only test covers every channel but popup, which the driver holds back before it loads |
| Manifest-sufficiency passes | Met: one perturbation per manifest field, enforced by the type check |

**Reviews, fixed** (SPEC-07; tests `3f1b8b1`, `6023ca9`; code `1b7b863`, `da4a7c8`):

| Gap | Fix |
|---|---|
| Container runs could reach the Docker host through the network's gateway | No gateway on internal networks; the probe tries the address; an unknown counts as reached |
| Applied rewrites never reached the manifest from a container | The proxy writes them to a file; `rewritesApplied()` on the handle |
| Browser records with no decision were stamped blocked, even on allowed tunnels | New join rule; it never claims an unseen request was allowed |
| Every container event was `unattributed` | Browser records from inside the container give the channel |
| A failed read of the proxy's files lost earlier evidence | Decisions already read are kept |
| A result could claim egress enforced whatever the runner said | `RunInputs.guaranteeLevel`, default `host` |
| A hand-built policy could widen rewrites | The proxy refuses to start with an undeclared or non-HTTP rewrite origin |
| IPv4-translated, local NAT64 and Teredo addresses were allowed | Refused |
| Smaller: `.git` mount check's case, a refused malformed request left unrecorded, a stopped daemon reported as `image-missing`, the product name hard-coded in `runner` | Fixed |

**Left as they are:** the `as TargetId` casts and two template strings in committed tests. No behaviour depends on them, and changing them would change committed tests.

**A record written too early.** `71b0218` says SPEC-08 was green on Linux, but I wrote that row before reading the check, and that check had exited 1 because Docker Desktop was stopped, so no tests ran. I started Docker and re-ran it: green, on the same code, with no failures. The commit can't be amended, so the correction is here.

**Kill criteria, as of 2026-11-01:**

| Signal | Status |
|---|---|
| Driver parity, by 2027-03-17 | Passing on the pinned image, locally and in CI on `7e78d28` |
| Isolation, by 2027-03-17 | Passing: CI's container step passed 105 of 105 on `55a0b5a` with the gateway fix in, on GitHub's runner. Before that, `7e78d28` passed 104 of 105; the one failure was a counter-example's own setup, fixed in `27312b3` |
| Language fit | Resolved by the founder's pivot at M1 |
| Velocity, M1 | Met at M1's exit |
| Problem fit, 5 of 15 calls by 2027-01-25 | Set aside by the founder (2026-11-01): the aim is a demo, to judge feasibility from seeing it work. It does not stop the build |
| Upkeep, velocity at M3 and later signals | Not due |

### Risks

- **The isolated path is proved in pieces.** See the §7 slice and the egress test above. The alpha's claim should stay at what each piece shows until SPEC-16 joins them.
- **Worker, popup and redirect blocking is not tested inside a real container.** The proxy code is the same, but the container path is not exercised for them.
- The gateway fix relies on a Docker bridge option and is verified on Docker Desktop 29.8.2 and GitHub's runner. Another Docker that keeps the gateway should give `host` by the probe, which is safe but loses the isolated claim.
- A workload run reads its decisions once at the end, and a failed read gives `[]` with no notice. Carried to M3.
- `cli`'s recording file and the `Runner` wiring for plan runs wait for SPEC-16.
- Recordings may hold personal data until SPEC-09, and masking them may affect replay (`replay-recordings.md`).
- Benchmark baseline values are placeholders until the first weekly run, so its alarm means nothing before then.
- Stale `revisum-run-*` containers are not swept at start, and an interrupted run has left some behind.
- The Linux half of the clipboard proof is skipped, as the image has no xclip.
- Untested: `firstAddressOf`'s tightened octet and prefix limits, and a plan with both calls and commands losing the claim twice.
- SPEC-35's spec text (line 91) lists an out-of-date loss-reason union.
- AC-SPEC-08-06's Windows golden must be remade when the engine version, the Playwright adapter or the result's shape changes.
