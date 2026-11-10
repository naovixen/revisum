// Plans and steps written as raw JSON, the way a person or an AI planner writes them, for the real
// parser to read.

export type JsonRecord = Readonly<Record<string, unknown>>;

export const PLAN_LANGUAGE_VERSION = "1.3";

export type PlanMeta = {
    readonly featureId: string;
    readonly specReference: string;
    readonly title: string;
};

// A raw plan for one target. `fields` adds top-level fields, such as `values` or `clock`. A plan
// must assert something; every test plan does.
export const rawPlan = (
    meta: PlanMeta,
    targetId: string,
    steps: readonly unknown[],
    fields: JsonRecord = {},
): JsonRecord => ({
    version: PLAN_LANGUAGE_VERSION,
    meta,
    targets: [targetId],
    steps,
    ...fields,
});

export const role = (roleName: string, name: unknown, extra: JsonRecord = {}): JsonRecord => ({
    by: "role",
    role: roleName,
    name,
    ...extra,
});
export const label = (labelText: unknown, extra: JsonRecord = {}): JsonRecord => ({
    by: "label",
    label: labelText,
    ...extra,
});
export const text = (shown: unknown, extra: JsonRecord = {}): JsonRecord => ({
    by: "text",
    text: shown,
    ...extra,
});
export const testId = (id: unknown, extra: JsonRecord = {}): JsonRecord => ({
    by: "testId",
    testId: id,
    ...extra,
});
export const reference = (valueName: string): JsonRecord => ({ valueName });
export const secretValue = (secretName: string): JsonRecord => ({ secretName });

export const navigate = (url: unknown): JsonRecord => ({ type: "navigate", url });
export const click = (locator: JsonRecord): JsonRecord => ({ type: "click", locator });
export const fill = (locator: JsonRecord, value: unknown): JsonRecord => ({
    type: "fill",
    locator,
    value,
});
export const press = (
    locator: JsonRecord,
    key: string,
    modifiers?: readonly string[],
): JsonRecord =>
    modifiers === undefined
        ? { type: "press", locator, key }
        : { type: "press", locator, key, modifiers };
export const remember = (
    name: string,
    element: JsonRecord,
    read: "text" | "value" = "text",
): JsonRecord => ({ type: "remember", name, from: { element, read } });
export const capture = (name: string): JsonRecord => ({ type: "capture", name });
export const newTab = (url: string, steps: readonly unknown[]): JsonRecord => ({
    type: "newTab",
    url,
    steps,
});

export const visible = (locator: JsonRecord, criterionId: string): JsonRecord => ({
    type: "expect",
    locator,
    assert: { kind: "visible" },
    criterionId,
});
export const textEquals = (
    locator: JsonRecord,
    value: unknown,
    criterionId: string,
): JsonRecord => ({ type: "expect", locator, assert: { kind: "textEquals", value }, criterionId });
export const valueEquals = (
    locator: JsonRecord,
    value: unknown,
    criterionId: string,
): JsonRecord => ({ type: "expect", locator, assert: { kind: "valueEquals", value }, criterionId });
export const pathStartsWith = (value: string, criterionId: string): JsonRecord => ({
    type: "expectPage",
    assert: { kind: "urlPathStartsWith", value },
    criterionId,
});
