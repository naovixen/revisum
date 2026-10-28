# SPEC-02: Project trust and approval

## Purpose

Stop an AI change from editing its own judge, and stop an agent from approving its own work. It serves "the agent says its tests pass, but it wrote the tests" (UP-04): the agent's tests can't pass by changing the tests, the origins or the baseline. "Approved by a person" means the owner's approval through the declared agent lock-down route, which suffices for every subject, or, optionally, a review core can verify. Nothing is gated behind a second person (founder, 2026-10-27: "I alone own it"). Outcome: trusted inputs are trusted by provenance. Every approval that gates a merge or counts toward `verifiedWithoutReviewShare`, `planApprovalsPerChange` or `unreviewedMergeShare` carries a proof core verifies, or a lock-down declaration core records as declared.

## Scope and non-goals

- **In:**
  - **Trusted files.** `project.json` (origins, services, matrix, limits, redaction, packs, secret names, policy, risk classes), `approvers.json`, `holdouts.json` (holdout-plan hashes per change class, SPEC-22; never the plans), `plans/**`, `baselines/**` and the code-owners file. Everything else in the repository is *application code*.
  - **Trusted by provenance.** Trusted files are read only from the protected branch or under an approval. An edit to a trusted file in the change under test is ignored (the protected-branch version is used) and raised as a `changed-with-code` review item.
  - **Approval routes:**
    1. **Code-owner review (verified; optional, for teams with code owners).**
       - Core fetches an approving review from the GitHub API, on the head commit that last changed the subject.
       - The reviewer is a user account (not a bot or app) that the protected-branch code-owners file names for the subject's path.
       - The reviewer is neither the change's author nor the author of any commit in it that touches the subject.
    2. **Agent lock-down (declared; the owner's route, sufficient for every subject).**
       - The project declares `AgentLockdown` in protected-branch `approvers.json`: the coding agent is denied push, merge and pull-request approval by deny rules. It may commit: a commit is not an approval, because nothing is approved until the maintainer pushes or merges it (founder decision, 2026-10-27).
       - The maintainer also declares whether the agent's environment holds GitHub credentials. Core records the answer in the declaration and can't check it.
       - The named maintainer pushes and merges personally, and only the protected default branch is trusted.
       - A subject is approved when it reaches the protected default branch through a merge or push by that maintainer's user account.
       - Core checks the parts it can see: the actor, the branch, and that the deny-rules file on the protected branch lists the push, merge and pull-request-approval denials. It can't see the agent's environment, so it records the approval as `declared`, never `verified`, and every output resting on it says so.
    3. **Signed key (verified; optional, not phase-1).**
       - `core approve` signs the subject hash with a key registered in protected-branch `approvers.json`.
       - Keys must be hardware-backed and require user presence; core rejects signatures without the user-presence flag.
       - Built only on customer demand.
  - **No second-person gate.** Every subject accepts the owner's approval through the agent lock-down route. The verified routes stay available, but no feature, level or metric requires `strength: 'verified'`; a team that wants two people enforces that in its own VCS settings, outside core. Outputs resting on a declared approval stay labelled "declared, not verified".
  - **Agent approvals never gate.** Every other approval or decision is recorded with `actorType: 'unverified'` or `'agent'`, never gates a merge and never counts toward those metrics. That covers the local CLI without a route, MCP sessions, and CI, bot or app tokens.
  - **Subjects**, each keyed by hash: a plan, a trusted-file change, a review decision (SPEC-13), a high-risk extra review (SPEC-21) and a holdout plan (SPEC-22).
  - **Proposal-only runs** for plans with no approval.
- **Non-goals:**
  - the holdout store and its access rules (SPEC-22);
  - a hosted approval UI (SPEC-24);
  - identity management beyond the version-control identities and keys the customer already has;
  - version-control providers other than GitHub until a partner asks.

## Interfaces and types

```ts
// project.json, the main trusted file.
export type ProjectData = {
  readonly origins: readonly { readonly origin: Origin; readonly production: boolean }[];
  readonly services: readonly { readonly name: ServiceName; readonly origin: Origin; readonly private: boolean }[];
  readonly matrix: readonly Target[]; readonly limits: PlanLimits;
  readonly redaction: { readonly unmaskSelectors: readonly string[]; readonly declaredPiiFields: readonly string[] };
  readonly packs: readonly PackId[]; readonly secretNames: readonly SecretName[]; readonly fixtures: readonly FixtureName[];
  readonly policy: { readonly irreversiblePatterns: IrreversiblePatterns; readonly destructiveUrlPatterns: readonly string[];
    readonly unnamedControlsAllowedByTestId: readonly string[] };
  readonly riskClasses: readonly { readonly changeClassId: string; readonly paths: readonly string[]; readonly risk: RiskClass }[];
};
export type Provenance =
  | { kind: 'protected-branch'; branch: string; commit: string }
  | { kind: 'approval'; approval: Approval };
export type TrustedProject = Brand<ProjectData & { provenance: Provenance }, 'TrustedProject'>;
export type ApprovalSubject = { kind: 'plan' | 'trusted-file' | 'review-decision' | 'extra-review' | 'holdout-plan'; hash: string; path?: string };
export type ApprovalProof =
  | { kind: 'code-owner-review'; provider: 'github'; repository: string; pullRequest: number; reviewId: string; commit: string }
  | { kind: 'agent-lockdown-merge'; provider: 'github'; repository: string; protectedBranch: string; commit: string; mergedBy: string }
  | { kind: 'signature'; keyId: string; signature: string; flags: { userPresent: boolean } };   // optional route
// The solo route, declared in protected-branch approvers.json. Core checks what it can see and records the rest as declared.
export type AgentLockdown = {
  readonly maintainer: string;              // GitHub login of the one person who pushes and merges
  readonly agentDenyRulesPath: string;      // the coding agent's deny-rules file, read from the protected branch
  readonly deniedActions: readonly ('commit' | 'push' | 'merge' | 'approve-pull-request')[];   // must include push, merge and approve-pull-request; commit is optional
  readonly agentHasGithubCredentials: boolean; // declared by the maintainer and recorded; core cannot check it
};
export type ApprovalStrength = 'verified' | 'declared';
export type Approval = Brand<{
  readonly subject: ApprovalSubject; readonly approver: ActorId;   // pseudonymous id, never the raw identity
  readonly proofKind: ApprovalProof['kind']; readonly strength: ApprovalStrength;
  readonly at: string;                                             // from GitHub or the signed payload, not the run's clock
}, 'Approval'>;
export type VerifiedApproval = Approval & { readonly strength: 'verified' };
export type DeclaredApproval = Approval & { readonly strength: 'declared' };
// Every gate, metric and level takes Approval, never VerifiedApproval: verified and declared both gate, and strength only
// selects the label. Agent, MCP and token sources never mint an Approval (they get an 'unverified' or 'agent' DerivedActor).
export type ApprovalErrorCode = 'self-approval' | 'bot-or-app' | 'not-code-owner' | 'stale-commit' | 'unknown-key'
  | 'bad-signature' | 'no-user-presence' | 'subject-mismatch' | 'version-control-unavailable'
  | 'not-maintainer' | 'not-protected-branch' | 'lockdown-not-declared';
export interface ApprovalVerifier {
  verify(subject: ApprovalSubject, proof: ApprovalProof, trusted: TrustedProject, versionControl: VersionControlPort):
    Promise<Result<{ approval: Approval; actor: DerivedActor }, ApprovalErrorCode>>;
}
// Records an approval with no usable proof; actorType 'unverified', or 'agent' for MCP and token sources.
export function unverified(subject: ApprovalSubject, source: 'local' | 'mcp' | 'token'): DerivedActor;
export function loadTrustedProject(path: string, versionControl: VersionControlPort): Result<TrustedProject, TrustError>;
export interface ApprovalStore { forSubject(subjectHash: string): readonly Approval[] }   // approvals already verified or declared
export function approvalFor(plan: Plan, store: ApprovalStore): Approval | null;
export type TrustError = { code: 'untrusted-source' | 'changed-with-code' | 'no-approval'; path: string };
export interface VersionControlPort {                              // read-only; GitHub first
  protectedFile(path: string): Promise<Result<{ bytes: Uint8Array; commit: string }, 'not-found' | 'unavailable'>>;
  reviews(pullRequest: number): Promise<Result<readonly VersionControlReview[], 'unavailable'>>;
  changedFiles(pullRequest: number): Promise<Result<readonly { path: string; authors: readonly string[] }[], 'unavailable'>>;
  landedBy(commit: string, branch: string): Promise<Result<{ login: string; type: 'user' | 'bot' | 'app' } | null, 'unavailable'>>;
}
export type VersionControlReview = { id: string; state: 'approved' | 'changes-requested' | 'commented'; commit: string; reviewer: { login: string; type: 'user' | 'bot' | 'app' } };
```

**Build notes.** Points the criteria leave open, settled while building (2026-10-28; `docs/decisions/answers.md`):

- **Project shape.** `project.json` keeps the built shape (`packages/engine/src/project/project-parser.ts`). The other fields above arrive with the spec that first reads them: `policy` (SPEC-03), `matrix` (SPEC-05), `redaction` (SPEC-09), `riskClasses` (SPEC-21), `services` and `packs` (SPEC-23). This spec adds only `productionOrigins`, a list of origins (empty by default), which proposal-only runs refuse.
- **Building the verifier.** `approvalVerifier({ events, actorKey })` returns the `ApprovalVerifier`. `events` is the `EventSink`; `actorKey` is the key that turns a login into a pseudonymous `ActorId`. Events gain an optional `proofKind` field (an addition to SPEC-27's event shape). A refused attempt appends `approval.refused` with its code.
- **Loading the trusted project.** `loadTrustedProject(path, versionControl, change)` is async because the port is. `path` is relative to the repository root. `change` lists the files the change edits. The result holds the project and the `changed-with-code` review items, each naming its file, and appends one `trusted.changed-with-code` event per file. SPEC-13 later queues the items.
- **Port additions.** The port gains `protectedBranch` (the branch name recorded in provenance), `pullRequest(number)`, which returns its author and head commit, and `lastCommitTouching(path, pullRequest)`. A review gains `submittedAt`, and `landedBy` gains `at`. `Approval.at` comes from these, never from the run's clock. A review is stale when its commit is not the last commit touching the subject.
- **Proposal runs and the merge gate (AC-SPEC-02-03).** `planStanding(plan, store)` returns `{ mode: 'approved', approval }` or `{ mode: 'proposal' }`. A proposal run refuses `productionOrigins` with `origin_not_allowed` before any driver call. `mergeGateOpen(standing)` is false for every proposal. SPEC-11 and SPEC-16 call it.
- **Labels (AC-SPEC-02-16).** `approvalLabel(approval)` returns `'declared, not verified'` or `'verified'`, and the run result carries it. The ladder label and metric wording are tested in SPEC-21 and SPEC-15, which call this function.
- **Formats.** `approvers.json` holds `agentLockdown` (the `AgentLockdown` fields) and, for the optional route, `signingKeys`. `holdouts.json` lists holdout-plan hashes by change class. The deny-rules file has the shape of a Claude Code `settings.json` (`permissions.deny`, as in this repository's `.claude/settings.json`). Push, merge and pull-request approval count as denied when rules deny `git push`, `git merge` or `gh pr merge`, and `gh pr review`, in Bash or PowerShell.
- **Signed route.** Not built in M1, per Milestone. AC-SPEC-02-10's two refusals (`unknown-key`, `no-user-presence`) are built and tested now. Checking a valid signature waits for customer demand, so no signature ever verifies until then.
- **Exhaustiveness.** SPEC-27's switch proof covers SPEC-27's own unions. This spec's codes join the error-anchor list in `docs/errors.md`.

## Acceptance criteria

- AC-SPEC-02-01: When `project.json` is read from a branch other than the protected branch and has no approval, core shall refuse it with `untrusted-source` (oracle: specified).
- AC-SPEC-02-02: When a change edits a trusted file together with application code, core shall run on the protected-branch version, raise a `needs-review` item `changed-with-code` naming the file, and append a `trusted.changed-with-code` event (oracle: specified).
- AC-SPEC-02-03: When a plan's hash has no approval, core shall run it only as a proposal on non-production origins, and its verdict shall not pass a merge gate (oracle: specified).
- AC-SPEC-02-04: When a plan changes by one byte, its previous approval shall no longer apply (oracle: specified).
- AC-SPEC-02-05: When a code-owner review or signature verifies, core shall append a `plan.approved` event with the subject hash, the pseudonymous approver, `actorType: 'person-verified'` and the proof kind (oracle: specified).
- AC-SPEC-02-06: On the optional code-owner route, when the approving reviewer is the change's author, or authored a commit in it that touches the subject, the verifier shall return `self-approval` (oracle: specified).
- AC-SPEC-02-07: When the approving review comes from a bot or app account, or the decision arrives through an MCP session or a CI token, it shall not verify, and the event shall carry `actorType: 'agent'` (oracle: specified).
- AC-SPEC-02-08: When the reviewer is not named for the subject's path in the protected-branch code-owners file, the verifier shall return `not-code-owner` (oracle: specified).
- AC-SPEC-02-09: When the review is on a commit older than the last commit that changed the subject, the verifier shall return `stale-commit` (oracle: specified).
- AC-SPEC-02-10: When the optional signed route is set up, a signature with a key not in the protected-branch `approvers.json` shall return `unknown-key`, and one without the user-presence flag shall return `no-user-presence` (oracle: specified).
- AC-SPEC-02-11: When a local decision has no proof, core shall record it as `unverified`. It shall never gate a merge or count toward `verifiedWithoutReviewShare`, `planApprovalsPerChange` or `unreviewedMergeShare` (oracle: specified).
- AC-SPEC-02-12: When the code-owners file or `approvers.json` is changed in the change under test, core shall verify against the protected-branch version (oracle: specified).
- AC-SPEC-02-13: When the GitHub API is unavailable, the approval shall be treated as absent with `version-control-unavailable`, never as verified or declared (oracle: specified).
- AC-SPEC-02-14: When a subject reaches the protected default branch through a merge or push by the `maintainer` named in protected-branch `approvers.json`, with `AgentLockdown` declared there and its deny-rules file listing the push, merge and pull-request-approval denials, whether or not commits are also denied, core shall (oracle: specified):
  - record a `DeclaredApproval` with `actorType: 'person-declared'`;
  - append a `plan.approved` event with proof kind `agent-lockdown-merge`.
- AC-SPEC-02-15: When the agent lock-down route is tried, it shall be refused (oracle: specified):
  - with `not-maintainer` when the merge or push actor is not the named maintainer, or is a bot, app or token;
  - with `not-protected-branch` when the subject is only on another branch;
  - with `lockdown-not-declared` when `AgentLockdown` is missing, or its deny-rules file is absent or lacks any of the push, merge and pull-request-approval denials.
- AC-SPEC-02-16: When a verdict, report, metric or level rests on a declared approval, it shall say "declared, not verified". The ladder label shall be `declared` (SPEC-21) (oracle: specified).
- AC-SPEC-02-17: When an approval from an agent, MCP session, CI token, bot or app is offered by any route, it shall never gate a merge, whatever the project declares (oracle: specified; red-team fixture repository).
- AC-SPEC-02-18: When a plan, trusted-file change, review decision, high-risk extra review or holdout plan has only the maintainer's `DeclaredApproval` under agent lock-down, core shall treat it as approved for every gate and metric exactly as a `VerifiedApproval`, differing only in the `declared` label (oracle: specified; one fixture per subject kind).
- AC-SPEC-02-19: When a project has one person, the maintainer, and no code-owners file or second account, every gate shall still be passable through the agent lock-down route, and no verdict, review item or level shall name a missing second approver (oracle: specified; solo fixture repository).
- AC-SPEC-02-20: When lint runs, no gate, metric or level function shall take `VerifiedApproval` as a parameter or test `strength === 'verified'` to decide whether something passes; `strength` may only select a label (oracle: specified).

## Dependencies

- SPEC-01 (plan hash); SPEC-27 (`DerivedActor`, `EventSink`).
- SPEC-14 chains the events at M3; SPEC-13, SPEC-16 and SPEC-21 call the verifier.
- Founder decision of 2026-10-27: no hardware security key; core's own build uses the agent lock-down route (SPEC-00).
- Research background: architecture (`04` Finding 4). Models edit tests to pass [C-R13-062].

## Milestone

M1 (code-owner review and agent lock-down routes). The signed key route is optional and built on customer demand.

## Satisfies

FR-04, FR-06
