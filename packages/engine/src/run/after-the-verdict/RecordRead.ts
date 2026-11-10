// A record read from the session once the steps have run: what it said, or that it could not say.
export const RecordReadKind = {
    Read: "read",
    Unread: "unread",
} as const;

export type RecordReadKind = (typeof RecordReadKind)[keyof typeof RecordReadKind];

// An unread record gives no value: an empty one would claim there was nothing to read.
export type RecordRead<Value> =
    | { readonly kind: typeof RecordReadKind.Read; readonly value: Value }
    | { readonly kind: typeof RecordReadKind.Unread };

export const recordRead = <Value>(value: Value): RecordRead<Value> => ({
    kind: RecordReadKind.Read,
    value,
});

export const RECORD_UNREAD = { kind: RecordReadKind.Unread } as const;

// What the record said, or `otherwise` where the result needs a value whether or not it was read.
export const readValueOr = <Value>(record: RecordRead<Value>, otherwise: Value): Value =>
    record.kind === RecordReadKind.Read ? record.value : otherwise;
