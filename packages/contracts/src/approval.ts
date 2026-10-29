// Approvals: who approved which subject, by which route, and how strongly core could check it.
// An Approval is minted only by the engine's approval verifier, after it has checked a proof
// against GitHub and the protected branch. Every gate, metric and level takes an Approval, never
// a VerifiedApproval: a verified and a declared approval both pass, and strength only selects the
// label shown beside a result. Agent, MCP and token sources never get an Approval at all.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import type { ActorId } from './audit-events.ts';
import type { Brand } from './brand.ts';
import type { Result } from './result.ts';

// What is approved, keyed by its hash. `path` is where the subject lives in the repository.
export type ApprovalSubject = {
  readonly kind: 'plan' | 'trusted-file' | 'review-decision' | 'extra-review' | 'holdout-plan';
  readonly hash: string;
  readonly path?: string;
};

// The evidence offered for an approval. Core checks each one against GitHub and the protected
// branch; nothing the proof claims is believed on its own.
export type ApprovalProof =
  | { readonly kind: 'code-owner-review'; readonly provider: 'github'; readonly repository: string; readonly pullRequest: number;
    readonly reviewId: string; readonly commit: string }
  | { readonly kind: 'agent-lockdown-merge'; readonly provider: 'github'; readonly repository: string; readonly protectedBranch: string;
    readonly commit: string; readonly mergedBy: string }
  // The optional signed route. Not built yet: a signature never verifies until it is.
  | { readonly kind: 'signature'; readonly keyId: string; readonly signature: string; readonly flags: { readonly userPresent: boolean } };

export type AgentLockdownAction = 'commit' | 'push' | 'merge' | 'approve-pull-request';

// The owner's route, declared in protected-branch approvers.json: the coding agent is denied push,
// merge and pull-request approval, and the named maintainer pushes and merges personally. Core
// checks what it can see and records the rest as declared.
export type AgentLockdown = {
  // The GitHub login of the one person who pushes and merges.
  readonly maintainer: string;
  // The coding agent's deny-rules file, read from the protected branch.
  readonly agentDenyRulesPath: string;
  // Must include push, merge and approve-pull-request; commit is optional, as a commit approves nothing.
  readonly deniedActions: readonly AgentLockdownAction[];
  // Declared by the maintainer and recorded; core cannot check it.
  readonly agentHasGithubCredentials: boolean;
};

// verified: core checked the approving account itself. declared: core checked the actor and the
// branch, but rests on the maintainer's declaration about the agent's environment.
export type ApprovalStrength = 'verified' | 'declared';

export type ApprovalFields = {
  readonly subject: ApprovalSubject;
  // Pseudonymous id, never the raw identity.
  readonly approver: ActorId;
  readonly proofKind: ApprovalProof['kind'];
  readonly strength: ApprovalStrength;
  // From GitHub or the signed payload, never the run's clock.
  readonly at: string;
};
export type Approval = Brand<ApprovalFields, 'Approval'>;
export type VerifiedApproval = Approval & { readonly strength: 'verified' };
export type DeclaredApproval = Approval & { readonly strength: 'declared' };

// The text shown beside anything that rests on an approval.
export type ApprovalLabel = 'verified' | 'declared, not verified';

// Why the approval verifier refused a proof. A refused approval is absent: it never gates.
export type ApprovalErrorCode = 'self-approval' | 'bot-or-app' | 'not-code-owner' | 'stale-commit' | 'unknown-key'
  | 'bad-signature' | 'no-user-presence' | 'subject-mismatch' | 'version-control-unavailable'
  | 'not-maintainer' | 'not-protected-branch' | 'lockdown-not-declared';

// Approvals already verified or declared, found by subject hash.
export interface ApprovalStore {
  forSubject(subjectHash: string): readonly Approval[];
}

// Why a trusted file could not be trusted.
export type TrustError = { readonly code: 'untrusted-source' | 'changed-with-code' | 'no-approval'; readonly path: string };

export type AccountType = 'user' | 'bot' | 'app';
export type VersionControlAccount = { readonly login: string; readonly type: AccountType };

export type VersionControlReview = {
  readonly id: string;
  readonly state: 'approved' | 'changes-requested' | 'commented';
  readonly commit: string;
  readonly reviewer: VersionControlAccount;
  readonly submittedAt: string;
};

// Read-only access to the repository's host; GitHub first. Every answer can be 'unavailable', and
// an approval that needs an unavailable answer is absent, never assumed.
export interface VersionControlPort {
  // The protected default branch, the only branch whose files are trusted.
  readonly protectedBranch: string;
  protectedFile(path: string): Promise<Result<{ readonly bytes: Uint8Array; readonly commit: string }, 'not-found' | 'unavailable'>>;
  reviews(pullRequest: number): Promise<Result<readonly VersionControlReview[], 'unavailable'>>;
  changedFiles(pullRequest: number): Promise<Result<readonly { readonly path: string; readonly authors: readonly string[] }[], 'unavailable'>>;
  // The pull request's author, as a login, and its head commit.
  pullRequest(pullRequest: number): Promise<Result<{ readonly author: string; readonly headCommit: string }, 'unavailable'>>;
  // The id of the last commit in the pull request that changed `path`.
  lastCommitTouching(path: string, pullRequest: number): Promise<Result<string, 'unavailable'>>;
  // The file at `path` as `commit` holds it: what a reviewer of that commit saw. A code-owner
  // review verifies only through a port that has it; ports that only load the trusted project
  // leave it out.
  fileAtCommit?(path: string, commit: string): Promise<Result<{ readonly bytes: Uint8Array }, 'not-found' | 'unavailable'>>;
  // Who landed `commit` on `branch`, and when; null when it never landed there.
  landedBy(commit: string, branch: string): Promise<Result<(VersionControlAccount & { readonly at: string }) | null, 'unavailable'>>;
}
