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
//   - agent lock-down (declared): the subject stands on the protected branch with the subject's
//     bytes, and the last commit touching it there is one that the maintainer named in
//     protected-branch approvers.json landed, with the lock-down declared there and the agent's
//     deny-rules file denying push, merge and pull-request approval. Core cannot see the agent's
//     environment, so this approval is always declared, never verified;
//   - signed key (optional, not built): unknown keys and signatures without user presence are
//     refused; until the route is built, no signature verifies.
import { posix } from "node:path";
import {
    AuditEventKind,
    ApprovalProofKind,
    VersionControlFailure,
    AccountType,
    VersionControlReviewState,
    ApprovalSubjectKind,
    failure,
    success,
    ActorType,
    type Approval,
    ApprovalErrorCode,
    type ApprovalFields,
    type ApprovalProof,
    ApprovalStrength,
    type ApprovalSubject,
    type DerivedActor,
    type EventSink,
    type Result,
    type VersionControlAccount,
    type VersionControlPort,
    type VersionControlReview,
} from "@revisum/contracts";
import { deriveActor, pseudonymousActorId, sourceActorId } from "./DeriveActor.ts";
import { brand } from "../foundation/Brand.ts";
import { canonicalJson, sha256 } from "../foundation/Sha256.ts";
import { planHash } from "../run/seal/BuildManifest.ts";
import { planParser } from "../plan/parse/PlanParser.ts";
import { readPlanText } from "../plan/readable/ReadPlanText.ts";
import {
    CODE_OWNERS_PATHS,
    parseJson,
    repositoryPath,
    type TrustedProject,
} from "../project/TrustedProject.ts";
import {
    REQUIRED_DENIED_ACTIONS,
    deniesRequiredActions,
    holdoutPlanHashes,
    parseApproversFile,
    parseDenyRules,
    type ApproversFile,
} from "./ApproversFile.ts";
import { isCodeOwner, parseCodeOwners, type CodeOwnerRule } from "./ParseCodeOwners.ts";
import { mintedApprovals } from "./MintedApprovals.ts";

const APPROVERS_FILE = "approvers.json";
const HOLDOUTS_FILE = "holdouts.json";
const PLANS_FOLDER = "plans/";

export type VerifiedOutcome = { readonly approval: Approval; readonly actor: DerivedActor };
export type VerifierResult = Result<VerifiedOutcome, ApprovalErrorCode>;

export interface ApprovalVerifier {
    verify(
        subject: ApprovalSubject,
        proof: ApprovalProof,
        trusted: TrustedProject,
        versionControl: VersionControlPort,
    ): Promise<VerifierResult>;
}

export type ApprovalVerifierOptions = {
    // Where plan.approved and approval.refused events go.
    readonly events: EventSink;
    // The customer's key that turns a login into a pseudonymous ActorId.
    readonly actorKey: string;
};

// Records a decision that has no usable proof. It mints no Approval: the actor is 'unverified' for
// a local decision and 'agent' for an MCP session or a CI token, and neither is a person.
export function unverified(
    subject: ApprovalSubject,
    source: "local" | "mcp" | "token",
): DerivedActor {
    // The subject is not part of the id: who decided is unknown, whatever was decided.
    const actorType: ActorType = source === "local" ? "unverified" : "agent";
    return deriveActor(sourceActorId(`${source} decision`), actorType);
}

// Stops a check early with the code it refuses with, and the actor the refusal is recorded against.
type Refusal = { readonly code: ApprovalErrorCode; readonly actor: DerivedActor };
type Checked<Value> =
    | { readonly ok: true; readonly value: Value }
    | { readonly ok: false; readonly refusal: Refusal };
type Approved = {
    readonly login: string;
    readonly strength: ApprovalStrength;
    readonly at: string;
};

// Both strengths are a person; the strength chooses only which label the actor carries.
const PERSON_FOR_STRENGTH: Readonly<Record<ApprovalStrength, ActorType>> = {
    verified: ActorType.PersonVerified,
    declared: ActorType.PersonDeclared,
};

const passed = <Value>(value: Value): Checked<Value> => ({ ok: true, value });

// The hash of the plan a file holds as a person wrote it, readable text or JSON the parser tidies, or
// null when it holds no plan this project's parser accepts.
function hashOfPlanAsWritten(
    bytes: Uint8Array,
    decoded: unknown,
    trusted: TrustedProject,
): string | null {
    const written =
        decoded === undefined
            ? readPlanText(new TextDecoder().decode(bytes), trusted.limits)
            : success({ json: decoded });
    if (!written.ok) {
        return null;
    }
    const parsed = planParser(trusted)(written.value.json);
    return parsed.ok ? planHash(parsed.value) : null;
}

// True when a file's bytes are the subject: for a holdout plan, a holdouts.json listing its hash;
// otherwise a file whose bytes, or whose canonical JSON, have the subject's hash; and for a plan, whose
// hash is over the plan as the parser returns it, a file that reads as that plan.
function holdsSubject(
    subject: ApprovalSubject,
    bytes: Uint8Array,
    trusted: TrustedProject,
): boolean {
    const decoded = parseJson(bytes);
    if (subject.kind === ApprovalSubjectKind.HoldoutPlan) {
        return holdoutPlanHashes(decoded).includes(subject.hash);
    }
    if (
        sha256(bytes) === subject.hash ||
        (decoded !== undefined && sha256(canonicalJson(decoded)) === subject.hash)
    ) {
        return true;
    }
    return (
        subject.kind === ApprovalSubjectKind.Plan &&
        hashOfPlanAsWritten(bytes, decoded, trusted) === subject.hash
    );
}

// The repository file an approval of this subject is about, or null when it can be about none. A
// holdout plan is in no file of its own, so only holdouts.json can show it, whatever path the
// caller gives. A plan must live in plans/ once any "." and ".." in its path are resolved.
function subjectFile(subject: ApprovalSubject): string | null {
    if (subject.kind === ApprovalSubjectKind.HoldoutPlan) {
        return HOLDOUTS_FILE;
    }
    if (subject.path === undefined) {
        return null;
    }
    const path = posix.normalize(repositoryPath(subject.path));
    return subject.kind === ApprovalSubjectKind.Plan && !path.startsWith(PLANS_FOLDER)
        ? null
        : path;
}

// What a reviewer last said about a commit: their latest approval or request for changes. A comment
// is neither, and on GitHub it leaves a review's standing as it was.
function latestVerdict(
    reviews: readonly VersionControlReview[],
    reviewed: VersionControlReview,
): VersionControlReview {
    const login = reviewed.reviewer.login.toLowerCase();
    return reviews
        .filter(
            (candidate) =>
                candidate.commit === reviewed.commit &&
                candidate.reviewer.login.toLowerCase() === login &&
                candidate.state !== VersionControlReviewState.Commented,
        )
        .reduce(
            (latest, candidate) =>
                Date.parse(latest.submittedAt) > Date.parse(candidate.submittedAt)
                    ? latest
                    : candidate,
            reviewed,
        );
}

export function approvalVerifier(options: ApprovalVerifierOptions): ApprovalVerifier {
    const { events, actorKey } = options;

    // A bot or app is an agent; a user whose approval does not count is unverified.
    const accountActor = (account: VersionControlAccount): DerivedActor =>
        deriveActor(
            pseudonymousActorId(account.login, actorKey),
            account.type === AccountType.User ? "unverified" : "agent",
        );
    const loginActor = (login: string): DerivedActor =>
        deriveActor(pseudonymousActorId(login, actorKey), "unverified");
    const refusedBy = <Value>(code: ApprovalErrorCode, actor: DerivedActor): Checked<Value> => ({
        ok: false,
        refusal: { code, actor },
    });

    // A protected-branch file, decoded as JSON. Missing is null; unavailable refuses.
    async function protectedJson(
        versionControl: VersionControlPort,
        path: string,
        actor: DerivedActor,
    ): Promise<Checked<unknown>> {
        const read = await versionControl.protectedFile(repositoryPath(path));
        if (read.ok) {
            return passed(parseJson(read.value.bytes));
        }
        return read.error === VersionControlFailure.Unavailable
            ? refusedBy("version-control-unavailable", actor)
            : passed(null);
    }

    async function codeOwnerRules(
        versionControl: VersionControlPort,
        actor: DerivedActor,
    ): Promise<Checked<readonly CodeOwnerRule[]>> {
        for (const path of CODE_OWNERS_PATHS) {
            const read = await versionControl.protectedFile(path);
            if (read.ok) {
                return passed(parseCodeOwners(new TextDecoder().decode(read.value.bytes)));
            }
            if (read.error === VersionControlFailure.Unavailable) {
                return refusedBy("version-control-unavailable", actor);
            }
        }
        // No code-owners file: nobody is a code owner.
        return passed([]);
    }

    async function checkCodeOwnerReview(
        subject: ApprovalSubject,
        proof: Extract<ApprovalProof, { kind: "code-owner-review" }>,
        trusted: TrustedProject,
        versionControl: VersionControlPort,
    ): Promise<Checked<Approved>> {
        const unknownReviewer = deriveActor(sourceActorId("code-owner review"), "unverified");
        const reviews = await versionControl.reviews(proof.pullRequest);
        if (!reviews.ok) {
            return refusedBy("version-control-unavailable", unknownReviewer);
        }
        const review = reviews.value.find((candidate) => candidate.id === proof.reviewId);
        if (review === undefined || review.state !== VersionControlReviewState.Approved) {
            return refusedBy("subject-mismatch", unknownReviewer);
        }
        const reviewer = accountActor(review.reviewer);
        if (review.reviewer.type !== AccountType.User) {
            return refusedBy("bot-or-app", reviewer);
        }
        if (latestVerdict(reviews.value, review).state !== VersionControlReviewState.Approved) {
            return refusedBy("subject-mismatch", reviewer);
        }
        const path = subjectFile(subject);
        if (path === null) {
            return refusedBy("subject-mismatch", reviewer);
        }

        const rules = await codeOwnerRules(versionControl, reviewer);
        if (!rules.ok) {
            return rules;
        }
        if (!isCodeOwner(rules.value, path, review.reviewer.login)) {
            return refusedBy("not-code-owner", reviewer);
        }

        const pullRequest = await versionControl.pullRequest(proof.pullRequest);
        const changedFiles = await versionControl.changedFiles(proof.pullRequest);
        if (!pullRequest.ok || !changedFiles.ok) {
            return refusedBy("version-control-unavailable", reviewer);
        }
        const changed = changedFiles.value.find((file) => repositoryPath(file.path) === path);
        if (changed === undefined) {
            return refusedBy("subject-mismatch", reviewer);
        }
        const sameLogin = (login: string): boolean =>
            login.toLowerCase() === review.reviewer.login.toLowerCase();
        if (sameLogin(pullRequest.value.author) || changed.authors.some(sameLogin)) {
            return refusedBy("self-approval", reviewer);
        }

        // What counts is GitHub's last commit touching the subject, never the commit the proof names.
        const lastCommit = await versionControl.lastCommitTouching(path, proof.pullRequest);
        if (!lastCommit.ok) {
            return refusedBy("version-control-unavailable", reviewer);
        }
        if (review.commit !== lastCommit.value) {
            return refusedBy("stale-commit", reviewer);
        }

        // The review covered the file at the subject's path in the reviewed commit, not the hash the
        // caller offers with it, so the hash must match those bytes. The protected branch is never
        // consulted: it may still hold the version the change replaces.
        const reviewed = await reviewedBytes(
            subject,
            path,
            review.commit,
            trusted,
            versionControl,
            reviewer,
        );
        if (!reviewed.ok) {
            return reviewed;
        }
        return passed({
            login: review.reviewer.login,
            strength: ApprovalStrength.Verified,
            at: review.submittedAt,
        });
    }

    // The subject's file as the reviewed commit holds it must have the subject's hash. For a holdout
    // plan that file is holdouts.json, which lists the hash.
    async function reviewedBytes(
        subject: ApprovalSubject,
        path: string,
        commit: string,
        trusted: TrustedProject,
        versionControl: VersionControlPort,
        actor: DerivedActor,
    ): Promise<Checked<true>> {
        // A port that cannot read a file at a commit cannot show what the reviewer saw.
        if (versionControl.fileAtCommit === undefined) {
            return refusedBy("version-control-unavailable", actor);
        }
        const read = await versionControl.fileAtCommit(path, commit);
        if (!read.ok) {
            return refusedBy(
                read.error === VersionControlFailure.Unavailable
                    ? "version-control-unavailable"
                    : "subject-mismatch",
                actor,
            );
        }
        return holdsSubject(subject, read.value.bytes, trusted)
            ? passed(true)
            : refusedBy("subject-mismatch", actor);
    }

    async function checkAgentLockdown(
        subject: ApprovalSubject,
        proof: Extract<ApprovalProof, { kind: "agent-lockdown-merge" }>,
        trusted: TrustedProject,
        versionControl: VersionControlPort,
    ): Promise<Checked<Approved>> {
        const claimed = loginActor(proof.mergedBy);
        const approversJson = await protectedJson(versionControl, APPROVERS_FILE, claimed);
        if (!approversJson.ok) {
            return approversJson;
        }
        const lockdown = parseApproversFile(approversJson.value)?.agentLockdown ?? null;
        if (
            lockdown === null ||
            !REQUIRED_DENIED_ACTIONS.every((action) => lockdown.deniedActions.includes(action))
        ) {
            return refusedBy("lockdown-not-declared", claimed);
        }
        const denyRulesJson = await protectedJson(
            versionControl,
            lockdown.agentDenyRulesPath,
            claimed,
        );
        if (!denyRulesJson.ok) {
            return denyRulesJson;
        }
        const denyRules = parseDenyRules(denyRulesJson.value);
        if (denyRules === null || !deniesRequiredActions(denyRules)) {
            return refusedBy("lockdown-not-declared", claimed);
        }

        if (proof.protectedBranch !== versionControl.protectedBranch) {
            return refusedBy("not-protected-branch", claimed);
        }
        const landed = await versionControl.landedBy(proof.commit, versionControl.protectedBranch);
        if (!landed.ok) {
            return refusedBy("version-control-unavailable", claimed);
        }
        if (landed.value === null) {
            return refusedBy("not-protected-branch", claimed);
        }
        const lander = accountActor(landed.value);
        const isMaintainer = landed.value.login.toLowerCase() === lockdown.maintainer.toLowerCase();
        // GitHub's answer decides who landed the commit; a proof naming someone else is not believed.
        const proofAgrees = landed.value.login.toLowerCase() === proof.mergedBy.toLowerCase();
        if (landed.value.type !== AccountType.User || !isMaintainer || !proofAgrees) {
            return refusedBy("not-maintainer", lander);
        }

        const onBranch = await subjectOnProtectedBranch(
            subject,
            proof.commit,
            trusted,
            versionControl,
            lander,
        );
        if (!onBranch.ok) {
            return onBranch;
        }
        return passed({
            login: landed.value.login,
            strength: ApprovalStrength.Declared,
            at: landed.value.at,
        });
    }

    // The subject as it stands on the protected branch must have the subject's hash, and the proof's
    // commit must be the last to touch it there: a commit the maintainer landed earlier says nothing
    // about bytes someone else landed since. For a holdout plan the file is holdouts.json.
    async function subjectOnProtectedBranch(
        subject: ApprovalSubject,
        commit: string,
        trusted: TrustedProject,
        versionControl: VersionControlPort,
        actor: DerivedActor,
    ): Promise<Checked<true>> {
        const path = subjectFile(subject);
        if (path === null) {
            return refusedBy("subject-mismatch", actor);
        }
        const read = await versionControl.protectedFile(path);
        if (!read.ok) {
            return refusedBy(
                read.error === VersionControlFailure.Unavailable
                    ? "version-control-unavailable"
                    : "not-protected-branch",
                actor,
            );
        }
        if (!holdsSubject(subject, read.value.bytes, trusted)) {
            return refusedBy("not-protected-branch", actor);
        }
        return read.value.commit === commit ? passed(true) : refusedBy("stale-commit", actor);
    }

    async function checkSignature(
        proof: Extract<ApprovalProof, { kind: "signature" }>,
        versionControl: VersionControlPort,
    ): Promise<Checked<Approved>> {
        const signer = loginActor(`key:${proof.keyId}`);
        const approversJson = await protectedJson(versionControl, APPROVERS_FILE, signer);
        if (!approversJson.ok) {
            return approversJson;
        }
        const approvers: ApproversFile | null = parseApproversFile(approversJson.value);
        if (approvers === null || !approvers.signingKeys.some((key) => key.keyId === proof.keyId)) {
            return refusedBy("unknown-key", signer);
        }
        if (!proof.flags.userPresent) {
            return refusedBy("no-user-presence", signer);
        }
        // Checking the signature itself waits for customer demand, so no signature can be shown good yet.
        return refusedBy("bad-signature", signer);
    }

    const checkProof = (
        subject: ApprovalSubject,
        proof: ApprovalProof,
        trusted: TrustedProject,
        versionControl: VersionControlPort,
    ): Promise<Checked<Approved>> => {
        switch (proof.kind) {
            case ApprovalProofKind.CodeOwnerReview:
                return checkCodeOwnerReview(subject, proof, trusted, versionControl);
            case ApprovalProofKind.AgentLockdownMerge:
                return checkAgentLockdown(subject, proof, trusted, versionControl);
            case ApprovalProofKind.Signature:
                return checkSignature(proof, versionControl);
        }
    };

    return {
        async verify(subject, proof, trusted, versionControl) {
            const refuse = (refusal: Refusal): VerifierResult => {
                events.append(
                    {
                        kind: AuditEventKind.ApprovalRefused,
                        subjectHash: subject.hash,
                        proofKind: proof.kind,
                        code: refusal.code,
                    },
                    refusal.actor,
                );
                return failure(refusal.code);
            };
            // The trusted project must come from the same protected branch the port reads.
            if (
                trusted.provenance.kind === "protected-branch" &&
                trusted.provenance.branch !== versionControl.protectedBranch
            ) {
                return refuse({
                    code: ApprovalErrorCode.NotProtectedBranch,
                    actor: deriveActor(sourceActorId("approval proof"), "unverified"),
                });
            }
            const checked = await checkProof(subject, proof, trusted, versionControl);
            if (!checked.ok) {
                return refuse(checked.refusal);
            }

            const { login, strength, at } = checked.value;
            const approver = pseudonymousActorId(login, actorKey);
            const actor = deriveActor(approver, PERSON_FOR_STRENGTH[strength]);
            // The file the proof was judged on, never a path the caller offers beside it.
            const judgedFile =
                subject.kind === ApprovalSubjectKind.HoldoutPlan ? HOLDOUTS_FILE : subject.path;
            const approval = brand<ApprovalFields, "Approval">({
                subject: {
                    kind: subject.kind,
                    hash: subject.hash,
                    ...(judgedFile === undefined ? {} : { path: judgedFile }),
                },
                approver,
                proofKind: proof.kind,
                strength,
                at,
            });
            const recorded = events.append(
                {
                    kind: AuditEventKind.PlanApproved,
                    subjectHash: subject.hash,
                    proofKind: proof.kind,
                },
                actor,
            );
            // An approval the audit sink did not record does not exist: it is absent, never assumed.
            if (!recorded.ok) {
                return failure("version-control-unavailable");
            }
            mintedApprovals.record(approval);
            return success({ approval, actor });
        },
    };
}
