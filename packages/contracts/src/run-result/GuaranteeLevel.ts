// How strongly a run is isolated. isolated: the run's network egress is enforced and it can be
// replayed. host: it ran on the host, with no egress enforcement and no replay claim.
export const GuaranteeLevel = {
    Isolated: "isolated",
    Host: "host",
} as const;
export type GuaranteeLevel = (typeof GuaranteeLevel)[keyof typeof GuaranteeLevel];
