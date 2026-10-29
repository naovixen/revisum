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
