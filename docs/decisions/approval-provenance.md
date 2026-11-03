# A standing rests on an approval this process minted

## In short

`ownStanding` keeps a plan approved only for the very `Approval` object the verifier returned in this process. A copy, read back from JSON or cloned, leaves the plan a proposal, even with the plan's own hash.

## Decisions

- The verifier records each approval it mints in a `WeakSet` (`engine/src/approval/MintedApprovals.ts`, not exported from the package). `ownStanding`, `planStanding` and `mergeGateOpen` read it. The policy gate and `run()` go through `ownStanding`.
- No `ApprovalStore` exists yet, and none is built here.
- **Any future `ApprovalStore` must re-verify.** An approval it loads from disk or a service reads as a proposal until the verifier has judged its proof again in this process, against the protected branch. A store may keep the proof to do that. It may not hand back stored fields as an `Approval`.

## Findings

- The `Approval` type's brand stops a caller writing one by accident. It says nothing at run time: a copy has the same fields and passes any check of them, so only run-time provenance can tell a verified approval from a loaded one.
- `cli`'s `--after` route asks `planStanding` for a store's approval. With a store that returns copies it now reports a proposal and stops with `after-plan-unapproved`, which is the safe way round.

## Risks

- An approval does not cross a process boundary. A run in another process, such as a container, starts as a proposal unless the verifier runs there too.
