// Whether a plan stands approved, or only as a proposal.
export const PlanStandingMode = {
  Approved: 'approved',
  Proposal: 'proposal',
} as const;

export type PlanStandingMode = (typeof PlanStandingMode)[keyof typeof PlanStandingMode];
