// Fields of the trusted project file that decide what a run may reach: a null is not a false, an
// origin listed twice is a mistake to surface, and a target field nothing reads must not sit in the
// project's hash claiming something untrue about the target.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parseProject } from "@revisum/engine";
import {
    ORIGIN,
    TARGET_ID,
    testProjectInput,
    type JsonRecord,
} from "../plan/examples/GoldenPlan.ts";

const SECOND_ORIGIN = "https://shop.example";

const PLAIN_TARGET: JsonRecord = {
    id: TARGET_ID,
    adapter: "cdp",
    engine: "chromium",
    device: "desktop-1280",
    locale: "de-DE",
    timezone: "Asia/Tokyo",
    colorScheme: "dark",
    reducedMotion: "reduce",
};

const projectWith = (fields: JsonRecord): JsonRecord => testProjectInput({}, fields);

const errorsOf = (project: JsonRecord): readonly string[] => {
    const parsed = parseProject(project);
    return parsed.ok ? [] : parsed.error.map((error) => `${error.code} ${error.path}`);
};

const UNREAD_TARGET_FIELDS: readonly { readonly field: string; readonly value: string }[] = [
    { field: "kind", value: "browser" },
    { field: "kind", value: "native-app" },
    { field: "provider", value: "local" },
    { field: "provider", value: "cloud" },
];

const READ_TARGET_FIELDS: readonly { readonly field: string; readonly value: unknown }[] = [
    { field: "version", value: "156.0.7258.5" },
    { field: "required", value: true },
];

describe("Using the project parser", () => {
    describe("given allowProductionForApprovedPlans set to null", () => {
        describe("when the project is parsed", () => {
            test("then it should refuse the field as wrong_type", () => {
                const project = projectWith({
                    policy: { allowProductionForApprovedPlans: null },
                });
                assert.deepEqual(errorsOf(project), [
                    "wrong_type $.policy.allowProductionForApprovedPlans",
                ]);
            });
        });
    });

    for (const isAllowed of [true, false]) {
        describe(`given allowProductionForApprovedPlans set to ${isAllowed}`, () => {
            describe("when the project is parsed", () => {
                test("then it should keep the value", () => {
                    const parsed = parseProject(
                        projectWith({ policy: { allowProductionForApprovedPlans: isAllowed } }),
                    );
                    assert.ok(parsed.ok, JSON.stringify(parsed));
                    assert.equal(parsed.value.policy.allowProductionForApprovedPlans, isAllowed);
                });
            });
        });
    }

    describe("given no allowProductionForApprovedPlans", () => {
        describe("when the project is parsed", () => {
            test("then it should read it as false", () => {
                const parsed = parseProject(projectWith({ policy: {} }));
                assert.ok(parsed.ok, JSON.stringify(parsed));
                assert.equal(parsed.value.policy.allowProductionForApprovedPlans, false);
            });
        });
    });

    describe("given an origin listed twice", () => {
        describe("when the project is parsed", () => {
            test("then it should refuse the list as duplicate", () => {
                const origins = [ORIGIN, SECOND_ORIGIN, ORIGIN];
                assert.deepEqual(errorsOf(projectWith({ origins })), ["duplicate $.origins"]);
            });
        });
    });

    describe("given two different origins", () => {
        describe("when the project is parsed", () => {
            test("then it should keep both", () => {
                const origins = [ORIGIN, SECOND_ORIGIN];
                const parsed = parseProject(projectWith({ origins }));
                assert.ok(parsed.ok, JSON.stringify(parsed));
                assert.deepEqual(parsed.value.origins, origins);
            });
        });
    });

    for (const { field, value } of UNREAD_TARGET_FIELDS) {
        describe(`given a target with ${field} ${value}`, () => {
            describe("when the project is parsed", () => {
                test("then it should refuse the field as unknown_field", () => {
                    const matrix = [{ ...PLAIN_TARGET, [field]: value }];
                    assert.deepEqual(errorsOf(projectWith({ matrix })), [
                        `unknown_field $.matrix[0].${field}`,
                    ]);
                });
            });
        });
    }

    for (const { field, value } of READ_TARGET_FIELDS) {
        describe(`given a target with ${field} ${String(value)}`, () => {
            describe("when the project is parsed", () => {
                test("then it should keep the field", () => {
                    const matrix = [{ ...PLAIN_TARGET, [field]: value }];
                    const parsed = parseProject(projectWith({ matrix }));
                    assert.ok(parsed.ok, JSON.stringify(parsed));
                    assert.equal(Reflect.get(parsed.value.matrix[0] ?? {}, field), value);
                });
            });
        });
    }
});
