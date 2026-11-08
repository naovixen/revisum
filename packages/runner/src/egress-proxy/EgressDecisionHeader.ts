// The header on every answer the proxy writes itself, rather than passes on from a service, so a
// client such as runner's service caller can tell the proxy's refusal or failure from a status the
// service sent. The proxy strips it from every service response, so a service cannot forge it.
export const EGRESS_DECISION_HEADER = "x-egress-decision";

// What the header says: the proxy refused the request, or could not get an answer from the service.
export const EgressDecisionMark = { Blocked: "blocked", Unreachable: "unreachable" } as const;
export type EgressDecisionMark = (typeof EgressDecisionMark)[keyof typeof EgressDecisionMark];

// The header's value as a mark. Only the proxy writes it, so a value it doesn't know is still the
// proxy's own answer, and is taken as a refusal: never as the service's.
export const parseEgressDecisionMark = (value: unknown): EgressDecisionMark =>
    Object.values(EgressDecisionMark).find((mark) => mark === value) ?? EgressDecisionMark.Blocked;
