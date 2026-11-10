// The check for script-like text looks for "<" followed by spaces and a tag name. On a long run of
// spaces it must not take time that grows with the square of the run, because two fields of a plan
// reach it before any length rule does, so a plan within its size limit could stall the parser.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isUnsafeText } from "@revisum/engine";
import { type JsonRecord } from "./examples/RunPlan.ts";
import { parserEnabling } from "../../plan/unsafe-features/examples/LostByFeature.ts";
import {
    CLASS_CHECK,
    FEATURES,
    OPEN_CART,
    SEED_EDITOR,
    unsafePlan,
} from "../../plan/unsafe-features/examples/UnsafePlan.ts";

const parsePlan = parserEnabling(FEATURES);

const LONG_RUN = `<${" ".repeat(64_000)}`;
// Well above what linear work takes, even on a busy machine, and well below the seconds the
// quadratic form takes at this length.
const TIME_LIMIT_MILLISECONDS = 1000;

const millisecondsFor = (action: () => unknown): number => {
    const start = performance.now();
    action();
    return performance.now() - start;
};

const HOSTILE_PLANS: readonly { readonly name: string; readonly plan: JsonRecord }[] = [
    {
        name: "a class name in a check",
        plan: unsafePlan([
            OPEN_CART,
            { ...CLASS_CHECK, assert: { kind: "hasClass", value: LONG_RUN } },
        ]),
    },
    {
        name: "a page script's argument",
        plan: unsafePlan([OPEN_CART, { ...SEED_EDITOR, arguments: { text: LONG_RUN } }]),
    },
];

const SCRIPT_LIKE_TEXTS: readonly string[] = [
    "<script>",
    "<   script>",
    "<  /  script  >",
    "<\t iframe src=x>",
];

const ORDINARY_TEXTS: readonly string[] = ["1 < 2", "a <   b", `${" ".repeat(64_000)}x`];

describe("Using the text safety check", () => {
    describe("given a less-than sign followed by 64,000 spaces", () => {
        describe("when the text is judged", () => {
            test("then it should answer well within a second", () => {
                const milliseconds = millisecondsFor(() => isUnsafeText(LONG_RUN));
                assert.ok(
                    milliseconds < TIME_LIMIT_MILLISECONDS,
                    `it took ${Math.round(milliseconds)} ms`,
                );
            });
        });
    });

    for (const { name, plan } of HOSTILE_PLANS) {
        describe(`given ${name} holding a less-than sign followed by 64,000 spaces`, () => {
            describe("when the plan is parsed", () => {
                test("then it should answer well within a second", () => {
                    const milliseconds = millisecondsFor(() => parsePlan(plan));
                    assert.ok(
                        milliseconds < TIME_LIMIT_MILLISECONDS,
                        `it took ${Math.round(milliseconds)} ms`,
                    );
                });
            });
        });
    }

    for (const text of SCRIPT_LIKE_TEXTS) {
        describe(`given the script-like text ${JSON.stringify(text)}`, () => {
            describe("when the text is judged", () => {
                test("then it should call it unsafe", () => {
                    assert.equal(isUnsafeText(text), true);
                });
            });
        });
    }

    for (const text of ORDINARY_TEXTS) {
        describe(`given the ordinary text ${JSON.stringify(text.slice(0, 16))}`, () => {
            describe("when the text is judged", () => {
                test("then it should call it safe, quickly", () => {
                    const milliseconds = millisecondsFor(() => {
                        assert.equal(isUnsafeText(text), false);
                    });
                    assert.ok(milliseconds < TIME_LIMIT_MILLISECONDS);
                });
            });
        });
    }
});
