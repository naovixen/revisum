// Approvals: who approved which subject, by which route, and how strongly core could check it.
// An Approval is minted only by the engine's approval verifier, after it has checked a proof
// against GitHub and the protected branch. Every gate, metric and level takes an Approval, never
// a VerifiedApproval: a verified and a declared approval both pass, and strength only selects the
// label shown beside a result. Agent, MCP and token sources never get an Approval at all.
import type { Brand } from '../foundation/Brand.ts';
import type { Result } from '../foundation/Result.ts';
import type { ActorId } from '../events/ActorId.ts';

// What is approved, keyed by its hash. `path` is where the subject lives in the repository.
export const ApprovalSubjectKind = {
  Plan: 'plan',
  TrustedFile: 'trusted-file',
  ReviewDecision: 'review-decision',
  ExtraReview: 'extra-review',
  HoldoutPlan: 'holdout-plan',
} as const;
export type ApprovalSubjectKind = (typeof ApprovalSubjectKind)[keyof typeof ApprovalSubjectKind];
export type ApprovalSubject = {
  readonly kind: ApprovalSubjectKind;
  readonly hash: string;
  readonly path?: string;
};

// The evidence offered for an approval. Core checks each one against GitHub and the protected
// branch; nothing the proof claims is believed on its own.
export const ApprovalProofKind = {
  CodeOwnerReview: 'code-owner-review',
  AgentLockdownMerge: 'agent-lockdown-merge',
  Signature: 'signature',
} as const;
export type ApprovalProofKind = (typeof ApprovalProofKind)[keyof typeof ApprovalProofKind];
export type ApprovalProof =
  | { readonly kind: typeof ApprovalProofKind.CodeOwnerReview; readonly provider: 'github'; readonly repository: string; readonly pullRequest: number;
    readonly reviewId: string; readonly commit: string }
  | { readonly kind: typeof ApprovalProofKind.AgentLockdownMerge; readonly provider: 'github'; readonly repository: string; readonly protectedBranch: string;
    readonly commit: string; readonly mergedBy: string }
  // The optional signed route. Not built yet: a signature never verifies until it is.
  | { readonly kind: typeof ApprovalProofKind.Signature; readonly keyId: string; readonly signature: string; readonly flags: { readonly userPresent: boolean } };

export const AgentLockdownAction = {
  Commit: 'commit',
  Push: 'push',
  Merge: 'merge',
  ApprovePullRequest: 'approve-pull-request',
} as const;
export type AgentLockdownAction = (typeof AgentLockdownAction)[keyof typeof AgentLockdownAction];

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
export const ApprovalStrength = {
  Verified: 'verified',
  Declared: 'declared',
} as const;
export type ApprovalStrength = (typeof ApprovalStrength)[keyof typeof ApprovalStrength];

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
export type VerifiedApproval = Approval & { readonly strength: typeof ApprovalStrength.Verified };
export type DeclaredApproval = Approval & { readonly strength: typeof ApprovalStrength.Declared };

// The text shown beside anything that rests on an approval.
export const ApprovalLabel = {
  Verified: 'verified',
  DeclaredNotVerified: 'declared, not verified',
} as const;
export type ApprovalLabel = (typeof ApprovalLabel)[keyof typeof ApprovalLabel];

// Why the approval verifier refused a proof. A refused approval is absent: it never gates.
export const ApprovalErrorCode = {
  SelfApproval: 'self-approval',
  BotOrApp: 'bot-or-app',
  NotCodeOwner: 'not-code-owner',
  StaleCommit: 'stale-commit',
  UnknownKey: 'unknown-key',
  BadSignature: 'bad-signature',
  NoUserPresence: 'no-user-presence',
  SubjectMismatch: 'subject-mismatch',
  VersionControlUnavailable: 'version-control-unavailable',
  NotMaintainer: 'not-maintainer',
  NotProtectedBranch: 'not-protected-branch',
  LockdownNotDeclared: 'lockdown-not-declared',
} as const;
export type ApprovalErrorCode = (typeof ApprovalErrorCode)[keyof typeof ApprovalErrorCode];

// Approvals already verified or declared, found by subject hash.
export interface ApprovalStore {
  forSubject(subjectHash: string): readonly Approval[];
}

// Why a trusted file could not be trusted.
export const TrustErrorCode = {
  UntrustedSource: 'untrusted-source',
  ChangedWithCode: 'changed-with-code',
  NoApproval: 'no-approval',
} as const;
export type TrustErrorCode = (typeof TrustErrorCode)[keyof typeof TrustErrorCode];
export type TrustError = { readonly code: TrustErrorCode; readonly path: string };

export const AccountType = {
  User: 'user',
  Bot: 'bot',
  App: 'app',
} as const;
export type AccountType = (typeof AccountType)[keyof typeof AccountType];
export type VersionControlAccount = { readonly login: string; readonly type: AccountType };

export const VersionControlReviewState = {
  Approved: 'approved',
  ChangesRequested: 'changes-requested',
  Commented: 'commented',
} as const;
export type VersionControlReviewState = (typeof VersionControlReviewState)[keyof typeof VersionControlReviewState];
export type VersionControlReview = {
  readonly id: string;
  readonly state: VersionControlReviewState;
  readonly commit: string;
  readonly reviewer: VersionControlAccount;
  readonly submittedAt: string;
};

export const VersionControlFailure = {
  NotFound: 'not-found',
  Unavailable: 'unavailable',
} as const;
export type VersionControlFailure = (typeof VersionControlFailure)[keyof typeof VersionControlFailure];
type Unanswered = typeof VersionControlFailure.Unavailable;

// Read-only access to the repository's host; GitHub first. Every answer can be 'unavailable', and
// an approval that needs an unavailable answer is absent, never assumed.
export interface VersionControlPort {
  // The protected default branch, the only branch whose files are trusted.
  readonly protectedBranch: string;
  // The file as it stands on the protected branch, and the last commit on that branch that changed
  // it: not the branch's head, which may have touched only other files.
  protectedFile(path: string): Promise<Result<{ readonly bytes: Uint8Array; readonly commit: string }, VersionControlFailure>>;
  reviews(pullRequest: number): Promise<Result<readonly VersionControlReview[], Unanswered>>;
  changedFiles(pullRequest: number): Promise<Result<readonly { readonly path: string; readonly authors: readonly string[] }[], Unanswered>>;
  // The pull request's author, as a login, and its head commit.
  pullRequest(pullRequest: number): Promise<Result<{ readonly author: string; readonly headCommit: string }, Unanswered>>;
  // The id of the last commit in the pull request that changed `path`.
  lastCommitTouching(path: string, pullRequest: number): Promise<Result<string, Unanswered>>;
  // The file at `path` as `commit` holds it: what a reviewer of that commit saw. A code-owner
  // review verifies only through a port that has it; ports that only load the trusted project
  // leave it out.
  fileAtCommit?(path: string, commit: string): Promise<Result<{ readonly bytes: Uint8Array }, VersionControlFailure>>;
  // Who landed `commit` on `branch`, and when; null when it never landed there.
  landedBy(commit: string, branch: string): Promise<Result<(VersionControlAccount & { readonly at: string }) | null, Unanswered>>;
}
