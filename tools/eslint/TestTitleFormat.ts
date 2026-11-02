// Test titles read as one sentence: Using the X, given a context, and more context, when an action,
// and a follow-up action, then it should react. Merged, they describe a behaviour.
import type { Rule } from "eslint";

type Phase = "subject" | "context" | "action" | "unknown";
type Frame = { readonly call: Rule.Node; readonly phase: Phase };
type CallKind = "describe" | "test";

const DEEPEST_LEVEL = 5;
const CALL_KINDS: Readonly<Record<string, CallKind>> = {
    describe: "describe",
    test: "test",
    it: "test",
};
const CALL_MODIFIERS = new Set(["only", "skip", "todo"]);

function callKind(call: Rule.Node): CallKind | null {
    if (call.type !== "CallExpression") {
        return null;
    }
    const { callee } = call;
    if (callee.type === "Identifier") {
        return CALL_KINDS[callee.name] ?? null;
    }
    const isModifiedCall =
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.property.type === "Identifier" &&
        CALL_MODIFIERS.has(callee.property.name);
    return isModifiedCall && callee.object.type === "Identifier"
        ? (CALL_KINDS[callee.object.name] ?? null)
        : null;
}

// The title's fixed opening, or null when it is only known at run time.
function titleOpening(call: Rule.Node): string | null {
    if (call.type !== "CallExpression") {
        return null;
    }
    const [title] = call.arguments;
    if (title?.type === "Literal" && typeof title.value === "string") {
        return title.value;
    }
    if (title?.type === "TemplateLiteral") {
        const opening = title.quasis[0]?.value.cooked ?? "";
        return opening === "" ? null : opening;
    }
    return null;
}

// The phase a nested describe moves to, or null when its keyword doesn't belong under its parent.
function nextPhase(parent: Phase, title: string): Phase | null {
    if (parent === "unknown") {
        return "unknown";
    }
    if (parent === "subject" && title.startsWith("given ")) {
        return "context";
    }
    if (parent === "context" && title.startsWith("and ")) {
        return "context";
    }
    if (parent !== "action" && title.startsWith("when ")) {
        return "action";
    }
    if (parent === "action" && title.startsWith("and ")) {
        return "action";
    }
    return null;
}

export const testTitleFormat: Rule.RuleModule = {
    meta: {
        type: "suggestion",
        docs: {
            description: "Structure test titles as Using, given, and, when, and, then it should",
        },
        schema: [],
        messages: {
            outermostTitle: "Start the outermost describe with 'Using', naming what is under test.",
            testOutsideDescribe: "Put this test inside a describe that starts with 'Using'.",
            testTitle: "Start the test title with 'then it should', describing the reaction.",
            testWithoutAction:
                "Put this test inside a 'when' describe, naming the action it reacts to.",
            nestedTitle:
                "Nest describes as 'given', then 'and' for more context, then 'when', then 'and' for a follow-up action.",
            tooDeep:
                "Nest at most five describes: merge the context into a longer 'given' or split the file.",
        },
    },
    create(context) {
        const frames: Frame[] = [];

        function checkDescribe(call: Rule.Node): void {
            const title = titleOpening(call);
            const parent = frames.at(-1);
            if (frames.length >= DEEPEST_LEVEL) {
                context.report({ node: call, messageId: "tooDeep" });
            }
            if (parent === undefined) {
                if (title !== null && !title.startsWith("Using ")) {
                    context.report({ node: call, messageId: "outermostTitle" });
                }
                frames.push({ call, phase: "subject" });
                return;
            }
            if (title === null) {
                frames.push({ call, phase: "unknown" });
                return;
            }
            const phase = nextPhase(parent.phase, title);
            if (phase === null) {
                context.report({ node: call, messageId: "nestedTitle" });
            }
            frames.push({ call, phase: phase ?? parent.phase });
        }

        function checkTest(call: Rule.Node): void {
            const parent = frames.at(-1);
            if (parent === undefined) {
                context.report({ node: call, messageId: "testOutsideDescribe" });
                return;
            }
            const title = titleOpening(call);
            if (title !== null && !title.startsWith("then it should ")) {
                context.report({ node: call, messageId: "testTitle" });
            }
            if (parent.phase === "subject" || parent.phase === "context") {
                context.report({ node: call, messageId: "testWithoutAction" });
            }
        }

        return {
            CallExpression(node) {
                const kind = callKind(node);
                if (kind === "describe") {
                    checkDescribe(node);
                }
                if (kind === "test") {
                    checkTest(node);
                }
            },
            "CallExpression:exit"(node: Rule.Node) {
                if (frames.at(-1)?.call === node) {
                    frames.pop();
                }
            },
        };
    },
};
