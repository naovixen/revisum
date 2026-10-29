// A plan's standing comes from its hash. With an approval of that hash it is approved; without one
// it runs only as a proposal, which never reaches production origins and never opens the merge
// gate. Changing a plan by one byte changes its hash, so the approval it had no longer applies.
// A declared approval opens the gate exactly as a verified one does: strength only picks the label.
// See docs/specs/SPEC-02-project-trust-and-approval.md.
import type { Approval, ApprovalLabel, ApprovalStore, ApprovalStrength, Plan } from '@revisum/contracts';
import { planHash } from '../manifest.ts';

export type PlanStanding = { readonly mode: 'approved'; readonly approval: Approval } | { readonly mode: 'proposal' };

// The approval of this exact plan, or null when its hash has none.
export function approvalFor(plan: Plan, store: ApprovalStore): Approval | null {
  const hash = planHash(plan);
  return store.forSubject(hash).find((approval) => approval.subject.kind === 'plan' && approval.subject.hash === hash) ?? null;
}

const PROPOSAL: PlanStanding = { mode: 'proposal' };

export function planStanding(plan: Plan, store: ApprovalStore): PlanStanding {
  const approval = approvalFor(plan, store);
  return approval === null ? PROPOSAL : { mode: 'approved', approval };
}

// The standing a plan may act on: the one it was given only when that standing's approval is for
// this plan's own hash. A standing made for another plan, or none at all, leaves it a proposal, so
// a caller cannot lend one plan's approval to another. The policy gate and run() both use this.
export function ownStanding(plan: Plan, standing: PlanStanding | undefined): PlanStanding {
  if (standing?.mode !== 'approved') return PROPOSAL;
  const subject = standing.approval.subject;
  return subject.kind === 'plan' && subject.hash === planHash(plan) ? standing : PROPOSAL;
}

// True only for an approved plan, whatever the approval's strength.
export const mergeGateOpen = (standing: PlanStanding): boolean => standing.mode === 'approved';

const APPROVAL_LABELS: Readonly<Record<ApprovalStrength, ApprovalLabel>> = { verified: 'verified', declared: 'declared, not verified' };

// What every verdict, report, metric or level resting on the approval says about it.
export const approvalLabel = (approval: Approval): ApprovalLabel => APPROVAL_LABELS[approval.strength];
