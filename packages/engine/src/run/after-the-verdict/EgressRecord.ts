// What the egress said it refused, read once the session has closed.
export const EgressRecordKind = {
    Read: "read",
    Unread: "unread",
} as const;

export type EgressRecordKind = (typeof EgressRecordKind)[keyof typeof EgressRecordKind];

// An unread egress gives no list: an empty one would say nothing was refused.
export type EgressRecord =
    | { readonly kind: typeof EgressRecordKind.Read; readonly blocked: readonly string[] }
    | { readonly kind: typeof EgressRecordKind.Unread };
