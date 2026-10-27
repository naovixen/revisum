# SPEC-13: Review queue and decision recorder

## Purpose

Name what still needs a person, and record what they decided. It serves "AI writes features faster than we can check them" (UP-01) and "bug reports don't show what broke" (UP-06): the queue is short and typed, and every human decision is counted. So `verifiedWithoutReviewShare` and the human work left over can be measured, testing whether manual checking can shrink to a small review queue (H1, H15).

## Scope and non-goals

- **In:** typed `needs-review` items for every check without a deciding oracle (accessibility `incomplete` and judgement criteria, visual baseline diffs, spec ambiguity, unrated severity, narrative approval, real-device checks); a reason and an action per item; a CLI recorder (`review accept|reject|set-severity`) with a reason; the actor derived from an approval through SPEC-02 (a decision without a proof is recorded `unverified` and never counts toward `verifiedWithoutReviewShare`; one made under agent lock-down counts and is labelled `declared`); decisions written as audit events and to a local, append-only history store (`history.jsonl` in the folder named from `PRODUCT`) that the metrics panel (SPEC-15) reads.
- **Non-goals:** a visual review UI (until the interface research's third trigger fires, research `11`; hosted in SPEC-24).

## Interfaces and types

```ts
export type ReviewReason = 'no-oracle' | 'engine-incomplete' | 'judgement-criterion' | 'baseline-diff'
  | 'spec-ambiguous' | 'severity-unrated' | 'narrative-approval' | 'real-device' | 'walk-cap';
export type ReviewItem = { id: string; findingId: string | null; reason: ReviewReason; action: string };
export type Decision =
  | { kind: 'accept' | 'reject'; itemId: string; reason: string }
  | { kind: 'set-severity'; itemId: string; severity: Severity; reason: string };
export interface DecisionRecorder {
  // The actor is derived from the proof, never passed in.
  record(decision: Decision, proof: ApprovalProof | null): Promise<Result<{ sequence: number; actorType: ActorType }, RecorderError>>;
}
export interface HistoryStore { append(record: RunRecord): void; read(): readonly RunRecord[] }   // append-only JSON Lines
// Share of changes whose verdict needed no human review decision. Person-verified and person-declared
// decisions count as human touches; unverified and agent decisions do not.
export function verifiedWithoutReviewShare(history: readonly RunRecord[]): number;
```

## Acceptance criteria

- AC-SPEC-13-01: When a check has no deciding oracle, core shall emit a `needs-review` item with a reason and an action, and the check shall never count as passed (oracle: specified).
- AC-SPEC-13-02: When the report renders the queue, its count shall equal the banner's needs-review count (oracle: specified; reuses AC-p6-13).
- AC-SPEC-13-03: When a decision is recorded without a reason, the recorder shall reject it (oracle: specified).
- AC-SPEC-13-04: When the recorded decisions for a fixture history are replayed, `verifiedWithoutReviewShare` shall equal the hand-computed value (oracle: specified).
- AC-SPEC-13-05: When a decision is recorded, an audit event with the item, decision, pseudonymous actor and the actor type derived by SPEC-02 shall be appended (oracle: specified).
- AC-SPEC-13-06: When a decision names an item id that is not in the queue, the recorder shall return `unknown-item` and write nothing (oracle: specified).
- AC-SPEC-13-07: When an item already has a verified decision, a second decision shall return `already-decided`; a verified decision on an item with only an unverified one shall supersede it, keeping both events (oracle: specified).
- AC-SPEC-13-08: When a run finishes, one `RunRecord` shall be appended to the history store, and earlier records shall be byte-identical afterwards (oracle: specified).
- AC-SPEC-13-09: When a fixture history mixes verified, declared and unverified decisions, `verifiedWithoutReviewShare` shall count only the verified and declared ones as human touches, and report the declared and unverified counts beside it (oracle: specified).
- AC-SPEC-13-10: When an item's decision is the maintainer's declared decision under agent lock-down, it shall settle the item exactly as a verified one: a later decision returns `already-decided`, it supersedes an unverified one, and no second account is needed (oracle: specified; founder decision 2026-10-27).

## Dependencies

- SPEC-02 (proof verification), SPEC-11; SPEC-14 for events.
- Research background: problem and users (`01` Finding 5); maturity and roles (`10` Findings 1 and 6). The human remains the final oracle where none is adequate [C-R11-003].

## Milestone

M3.

## Satisfies

FR-16, FR-17
