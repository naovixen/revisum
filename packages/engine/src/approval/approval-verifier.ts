// The approval verifier: the only module that mints an Approval. It checks a proof against GitHub
// and the files on the protected branch, never against anything the change under test supplies,
// and records the outcome: plan.approved for an approval, approval.refused with its code for a
// refusal. An account that is a bot or an app is recorded as an agent and never approves.
//
// Routes:
//   - code-owner review (verified): an approving review by a user account that the protected-branch
//     code-owners file names for the subject's path, on the last commit that touched the subject,
//     by someone who neither opened the change nor wrote a commit in it that touches the subject,
//     for a subject whose hash matches the file at its path in that reviewed commit, so a review
//     approves only the bytes the reviewer saw, before the change merges, and never a subject hash
//     nobody reviewed;
//   - agent lock-down (declared): the subject is on the protected branch through a commit that the
//     maintainer named in protected-branch approvers.json landed, with the lock-down declared there
//     and the agent's deny-rules file denying push, merge and pull-request approval. Core cannot
//     see the agent's environment, so this approval is always declared, never verified;
//   - signed key (optional, not built): unknown keys and signatures without user presence are
//     refused; until the route is built, no signature verifies.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import {
  failure, success,
  type ActorType, type Approval, type ApprovalErrorCode, type ApprovalFields, type ApprovalProof, type ApprovalStrength, type ApprovalSubject,
  type DerivedActor, type EventSink, type Result, type VersionControlAccount, type VersionControlPort,
} from '@revisum/contracts';
import { deriveActor, pseudonymousActorId, sourceActorId } from '../actor.ts';
import { brand } from '../brand.ts';
import { canonicalJson, sha256 } from '../hashing.ts';
import { CODE_OWNERS_PATHS, parseJson, repositoryPath, type TrustedProject } from '../project/trusted-project.ts';
import {
  REQUIRED_DENIED_ACTIONS, deniesRequiredActions, holdoutPlanHashes, parseApproversFile, parseDenyRules, type ApproversFile,
} from './approvers-file.ts';
import { isCodeOwner, parseCodeOwners, type CodeOwnerRule } from './code-owners.ts';

export const APPROVERS_FILE = 'approvers.json';
export const HOLDOUTS_FILE = 'holdouts.json';

export type VerifiedOutcome = { readonly approval: Approval; readonly actor: DerivedActor };
export type VerifierResult = Result<VerifiedOutcome, ApprovalErrorCode>;

export interface ApprovalVerifier {
  verify(subject: ApprovalSubject, proof: ApprovalProof, trusted: TrustedProject, versionControl: VersionControlPort): Promise<VerifierResult>;
}

export type ApprovalVerifierOptions = {
  // Where plan.approved and approval.refused events go.
  readonly events: EventSink;
  // The customer's key that turns a login into a pseudonymous ActorId.
  readonly actorKey: string;
};

// Records a decision that has no usable proof. It mints no Approval: the actor is 'unverified' for
// a local decision and 'agent' for an MCP session or a CI token, and neither is a person.
export function unverified(subject: ApprovalSubject, source: 'local' | 'mcp' | 'token'): DerivedActor {
  // The subject is not part of the id: who decided is unknown, whatever was decided.
  const actorType: ActorType = source === 'local' ? 'unverified' : 'agent';
  return deriveActor(sourceActorId(`${source} decision`), actorType);
}

// Stops a check early with the code it refuses with, and the actor the refusal is recorded against.
type Refusal = { readonly code: ApprovalErrorCode; readonly actor: DerivedActor };
type Checked<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly refusal: Refusal };
type Approved = { readonly login: string; readonly strength: ApprovalStrength; readonly at: string };

// Both strengths are a person; the strength chooses only which label the actor carries.
const PERSON_FOR_STRENGTH: Readonly<Record<ApprovalStrength, ActorType>> = { verified: 'person-verified', declared: 'person-declared' };

const passed = <Value>(value: Value): Checked<Value> => ({ ok: true, value });

// True when a file's bytes are the subject: for a holdout plan, a holdouts.json listing its hash;
// otherwise a file whose bytes, or whose canonical JSON (a plan's hash is over its canonical JSON),
// have the subject's hash.
function holdsSubject(subject: ApprovalSubject, bytes: Uint8Array): boolean {
  const decoded = parseJson(bytes);
  if (subject.kind === 'holdout-plan') return holdoutPlanHashes(decoded).includes(subject.hash);
  return sha256(bytes) === subject.hash || (decoded !== undefined && sha256(canonicalJson(decoded)) === subject.hash);
}

export function approvalVerifier(options: ApprovalVerifierOptions): ApprovalVerifier {
  const { events, actorKey } = options;

  // A bot or app is an agent; a user whose approval does not count is unverified.
  const accountActor = (account: VersionControlAccount): DerivedActor =>
    deriveActor(pseudonymousActorId(account.login, actorKey), account.type === 'user' ? 'unverified' : 'agent');
  const loginActor = (login: string): DerivedActor => deriveActor(pseudonymousActorId(login, actorKey), 'unverified');
  const refusedBy = <Value>(code: ApprovalErrorCode, actor: DerivedActor): Checked<Value> => ({ ok: false, refusal: { code, actor } });

  // A protected-branch file, decoded as JSON. Missing is null; unavailable refuses.
  async function protectedJson(versionControl: VersionControlPort, path: string, actor: DerivedActor): Promise<Checked<unknown>> {
    const read = await versionControl.protectedFile(repositoryPath(path));
    if (read.ok) return passed(parseJson(read.value.bytes));
    return read.error === 'unavailable' ? refusedBy('version-control-unavailable', actor) : passed(null);
  }

  async function codeOwnerRules(versionControl: VersionControlPort, actor: DerivedActor): Promise<Checked<readonly CodeOwnerRule[]>> {
    for (const path of CODE_OWNERS_PATHS) {
      const read = await versionControl.protectedFile(path);
      if (read.ok) return passed(parseCodeOwners(new TextDecoder().decode(read.value.bytes)));
      if (read.error === 'unavailable') return refusedBy('version-control-unavailable', actor);
    }
    // No code-owners file: nobody is a code owner.
    return passed([]);
  }

  async function checkCodeOwnerReview(
    subject: ApprovalSubject, proof: Extract<ApprovalProof, { kind: 'code-owner-review' }>, versionControl: VersionControlPort,
  ): Promise<Checked<Approved>> {
    const unknownReviewer = deriveActor(sourceActorId('code-owner review'), 'unverified');
    const reviews = await versionControl.reviews(proof.pullRequest);
    if (!reviews.ok) return refusedBy('version-control-unavailable', unknownReviewer);
    const review = reviews.value.find((candidate) => candidate.id === proof.reviewId);
    if (review === undefined || review.state !== 'approved') return refusedBy('subject-mismatch', unknownReviewer);
    const reviewer = accountActor(review.reviewer);
    if (review.reviewer.type !== 'user') return refusedBy('bot-or-app', reviewer);
    if (subject.path === undefined) return refusedBy('subject-mismatch', reviewer);
    const path = repositoryPath(subject.path);

    const rules = await codeOwnerRules(versionControl, reviewer);
    if (!rules.ok) return rules;
    if (!isCodeOwner(rules.value, path, review.reviewer.login)) return refusedBy('not-code-owner', reviewer);

    const pullRequest = await versionControl.pullRequest(proof.pullRequest);
    const changedFiles = await versionControl.changedFiles(proof.pullRequest);
    if (!pullRequest.ok || !changedFiles.ok) return refusedBy('version-control-unavailable', reviewer);
    const changed = changedFiles.value.find((file) => repositoryPath(file.path) === path);
    if (changed === undefined) return refusedBy('subject-mismatch', reviewer);
    const sameLogin = (login: string): boolean => login.toLowerCase() === review.reviewer.login.toLowerCase();
    if (sameLogin(pullRequest.value.author) || changed.authors.some(sameLogin)) return refusedBy('self-approval', reviewer);

    // What counts is GitHub's last commit touching the subject, never the commit the proof names.
    const lastCommit = await versionControl.lastCommitTouching(path, proof.pullRequest);
    if (!lastCommit.ok) return refusedBy('version-control-unavailable', reviewer);
    if (review.commit !== lastCommit.value) return refusedBy('stale-commit', reviewer);

    // The review covered the file at the subject's path in the reviewed commit, not the hash the
    // caller offers with it, so the hash must match those bytes. The protected branch is never
    // consulted: it may still hold the version the change replaces.
    const reviewed = await reviewedBytes(subject, path, review.commit, versionControl, reviewer);
    if (!reviewed.ok) return reviewed;
    return passed({ login: review.reviewer.login, strength: 'verified', at: review.submittedAt });
  }

  // The subject's file as the reviewed commit holds it must have the subject's hash. A holdout
  // plan's hash is listed in holdouts.json at that commit instead.
  async function reviewedBytes(
    subject: ApprovalSubject, path: string, commit: string, versionControl: VersionControlPort, actor: DerivedActor,
  ): Promise<Checked<true>> {
    // A port that cannot read a file at a commit cannot show what the reviewer saw.
    if (versionControl.fileAtCommit === undefined) return refusedBy('version-control-unavailable', actor);
    const file = subject.kind === 'holdout-plan' ? HOLDOUTS_FILE : path;
    const read = await versionControl.fileAtCommit(repositoryPath(file), commit);
    if (!read.ok) return refusedBy(read.error === 'unavailable' ? 'version-control-unavailable' : 'subject-mismatch', actor);
    return holdsSubject(subject, read.value.bytes) ? passed(true) : refusedBy('subject-mismatch', actor);
  }

  async function checkAgentLockdown(
    subject: ApprovalSubject, proof: Extract<ApprovalProof, { kind: 'agent-lockdown-merge' }>, versionControl: VersionControlPort,
  ): Promise<Checked<Approved>> {
    const claimed = loginActor(proof.mergedBy);
    const approversJson = await protectedJson(versionControl, APPROVERS_FILE, claimed);
    if (!approversJson.ok) return approversJson;
    const lockdown = parseApproversFile(approversJson.value)?.agentLockdown ?? null;
    if (lockdown === null || !REQUIRED_DENIED_ACTIONS.every((action) => lockdown.deniedActions.includes(action))) {
      return refusedBy('lockdown-not-declared', claimed);
    }
    const denyRulesJson = await protectedJson(versionControl, lockdown.agentDenyRulesPath, claimed);
    if (!denyRulesJson.ok) return denyRulesJson;
    const denyRules = parseDenyRules(denyRulesJson.value);
    if (denyRules === null || !deniesRequiredActions(denyRules)) return refusedBy('lockdown-not-declared', claimed);

    if (proof.protectedBranch !== versionControl.protectedBranch) return refusedBy('not-protected-branch', claimed);
    const landed = await versionControl.landedBy(proof.commit, versionControl.protectedBranch);
    if (!landed.ok) return refusedBy('version-control-unavailable', claimed);
    if (landed.value === null) return refusedBy('not-protected-branch', claimed);
    const lander = accountActor(landed.value);
    const isMaintainer = landed.value.login.toLowerCase() === lockdown.maintainer.toLowerCase();
    // GitHub's answer decides who landed the commit; a proof naming someone else is not believed.
    const proofAgrees = landed.value.login.toLowerCase() === proof.mergedBy.toLowerCase();
    if (landed.value.type !== 'user' || !isMaintainer || !proofAgrees) return refusedBy('not-maintainer', lander);

    const onBranch = await subjectOnProtectedBranch(subject, versionControl, lander);
    if (!onBranch.ok) return onBranch;
    return passed({ login: landed.value.login, strength: 'declared', at: landed.value.at });
  }

  // The subject as it stands on the protected branch must have the subject's hash; a holdout plan
  // is never in the repository, so holdouts.json must list its hash instead.
  async function subjectOnProtectedBranch(subject: ApprovalSubject, versionControl: VersionControlPort, actor: DerivedActor): Promise<Checked<true>> {
    const path = subject.kind === 'holdout-plan' ? HOLDOUTS_FILE : subject.path;
    if (path === undefined) return refusedBy('subject-mismatch', actor);
    const read = await versionControl.protectedFile(repositoryPath(path));
    if (!read.ok) return refusedBy(read.error === 'unavailable' ? 'version-control-unavailable' : 'not-protected-branch', actor);
    return holdsSubject(subject, read.value.bytes) ? passed(true) : refusedBy('not-protected-branch', actor);
  }

  async function checkSignature(
    proof: Extract<ApprovalProof, { kind: 'signature' }>, versionControl: VersionControlPort,
  ): Promise<Checked<Approved>> {
    const signer = loginActor(`key:${proof.keyId}`);
    const approversJson = await protectedJson(versionControl, APPROVERS_FILE, signer);
    if (!approversJson.ok) return approversJson;
    const approvers: ApproversFile | null = parseApproversFile(approversJson.value);
    if (approvers === null || !approvers.signingKeys.some((key) => key.keyId === proof.keyId)) return refusedBy('unknown-key', signer);
    if (!proof.flags.userPresent) return refusedBy('no-user-presence', signer);
    // Checking the signature itself waits for customer demand, so no signature can be shown good yet.
    return refusedBy('bad-signature', signer);
  }

  const checkProof = (subject: ApprovalSubject, proof: ApprovalProof, versionControl: VersionControlPort): Promise<Checked<Approved>> => {
    switch (proof.kind) {
      case 'code-owner-review': return checkCodeOwnerReview(subject, proof, versionControl);
      case 'agent-lockdown-merge': return checkAgentLockdown(subject, proof, versionControl);
      case 'signature': return checkSignature(proof, versionControl);
    }
  };

  return {
    async verify(subject, proof, trusted, versionControl) {
      const refuse = (refusal: Refusal): VerifierResult => {
        events.append({ kind: 'approval.refused', subjectHash: subject.hash, proofKind: proof.kind, code: refusal.code }, refusal.actor);
        return failure(refusal.code);
      };
      // The trusted project must come from the same protected branch the port reads.
      if (trusted.provenance.kind === 'protected-branch' && trusted.provenance.branch !== versionControl.protectedBranch) {
        return refuse({ code: 'not-protected-branch', actor: deriveActor(sourceActorId('approval proof'), 'unverified') });
      }
      const checked = await checkProof(subject, proof, versionControl);
      if (!checked.ok) return refuse(checked.refusal);

      const { login, strength, at } = checked.value;
      const approver = pseudonymousActorId(login, actorKey);
      const actor = deriveActor(approver, PERSON_FOR_STRENGTH[strength]);
      const approval = brand<ApprovalFields, 'Approval'>({
        subject: { kind: subject.kind, hash: subject.hash, ...(subject.path === undefined ? {} : { path: subject.path }) },
        approver, proofKind: proof.kind, strength, at,
      });
      const recorded = events.append({ kind: 'plan.approved', subjectHash: subject.hash, proofKind: proof.kind }, actor);
      // An approval the audit sink did not record does not exist: it is absent, never assumed.
      if (!recorded.ok) return failure('version-control-unavailable');
      return success({ approval, actor });
    },
  };
}
