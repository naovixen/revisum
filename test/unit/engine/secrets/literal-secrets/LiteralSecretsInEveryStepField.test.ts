// A secret written into a plan is refused wherever it stands. Every text a step of every type
// holds is replaced in turn with a literal secret: where the step takes free text the parser names
// it literal_secret, and anywhere else the plan is refused all the same, so a step type whose
// reader takes text without looking for secrets can't parse.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { StepType } from "@revisum/contracts";
import type { Plan } from "@revisum/engine";
import {
    DECLARED_FIXTURE,
    EVERY_STEP_TYPE_EXAMPLES,
    PLAIN_PATH,
    PLAIN_WORDS,
    type StepExample,
} from "../../plan/examples/EveryStepTypeExamples.ts";
import { withValue } from "../../plan/examples/GoldenPlan.ts";
import {
    errorsOf,
    parserEnabling,
    rejection,
    type ParsePlan,
} from "../../plan/unsafe-features/examples/LostByFeature.ts";
import { FEATURES, unsafePlan } from "../../plan/unsafe-features/examples/UnsafePlan.ts";

const LITERAL_SECRET = "AKIAABCDEFGHIJKLMNOP";
const FREE_TEXT: readonly unknown[] = [PLAIN_WORDS, PLAIN_PATH];

const parsePlan: ParsePlan = parserEnabling(FEATURES, { fixtures: [DECLARED_FIXTURE] });

type PathSegment = string | number;
type TextField = { readonly path: readonly PathSegment[]; readonly text: string };

const isRecordOrList = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null;

const textFieldsWithin = (
    value: unknown,
    path: readonly PathSegment[] = [],
): readonly TextField[] => {
    if (typeof value === "string") {
        return [{ path, text: value }];
    }
    if (Array.isArray(value)) {
        return value.flatMap((item, index) => textFieldsWithin(item, [...path, index]));
    }
    return isRecordOrList(value)
        ? Object.entries(value).flatMap(([key, item]) => textFieldsWithin(item, [...path, key]))
        : [];
};

const jsonPathOf = (path: readonly PathSegment[]): string =>
    `$${path.map((segment) => (typeof segment === "number" ? `[${segment}]` : `.${segment}`)).join("")}`;

const planOf = ({ step, before = [] }: StepExample): Plan | Readonly<Record<string, unknown>> =>
    unsafePlan([...before, step]);

const examplesOfEveryType = (): readonly {
    readonly type: string;
    readonly example: StepExample;
}[] =>
    Object.entries(EVERY_STEP_TYPE_EXAMPLES).flatMap(([type, examples]) =>
        examples.map((example: StepExample) => ({ type, example })),
    );

describe("Using the plan parser", () => {
    describe("given the table of examples of every step type", () => {
        describe("when its step types are listed", () => {
            test("then it should hold every step type the plan language has", () => {
                assert.deepEqual(
                    Object.keys(EVERY_STEP_TYPE_EXAMPLES).toSorted(),
                    Object.values(StepType).toSorted(),
                );
            });
        });
    });

    for (const { type, example } of examplesOfEveryType()) {
        describe(`given a ${type} step ${example.name}`, () => {
            const stepIndex = (example.before ?? []).length;

            describe("when the plan is parsed as written", () => {
                test("then it should accept the plan", () => {
                    const parsed = parsePlan(planOf(example));
                    assert.ok(parsed.ok, JSON.stringify(parsed));
                });
            });

            for (const { path, text } of textFieldsWithin(example.step)) {
                const planPath = ["steps", stepIndex, ...path];
                const field = jsonPathOf(planPath);

                describe(`when a literal secret replaces the text at ${field}`, () => {
                    const planWithSecret = (): unknown =>
                        withValue(planOf(example), planPath, LITERAL_SECRET);

                    if (FREE_TEXT.includes(text)) {
                        test("then it should refuse the plan as literal_secret at that field", () => {
                            assert.ok(
                                rejection(parsePlan, planWithSecret()).includes(
                                    `literal_secret ${field}`,
                                ),
                                JSON.stringify(rejection(parsePlan, planWithSecret())),
                            );
                        });
                    } else {
                        test("then it should refuse the plan", () => {
                            assert.equal(parsePlan(planWithSecret()).ok, false);
                        });
                    }

                    test("then it should not repeat the secret in what it reports", () => {
                        const errors = JSON.stringify(errorsOf(parsePlan, planWithSecret()));
                        assert.equal(errors.includes(LITERAL_SECRET), false);
                    });
                });
            }
        });
    }
});
