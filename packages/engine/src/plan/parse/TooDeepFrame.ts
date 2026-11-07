import { isNonArrayObject } from "@revisum/contracts";
import {
    canStandInside,
    frameDepthInside,
    holdsStepsOfType,
    isDeeperThanAllowed,
    isStepType,
} from "../StepFacts.ts";

type PendingList = {
    readonly steps: unknown;
    readonly path: string;
    readonly depth: number;
    readonly topLevel: boolean;
};

const plainFields = (input: unknown): Readonly<Record<string, unknown>> | undefined =>
    isNonArrayObject(input) ? Object.fromEntries(Object.entries(input)) : undefined;

// The type of a step that holds steps of its own and is read where it stands, or undefined. The
// parser reads nothing inside a step standing where it may not, so neither does the walk.
function holdingTypeOf(fields: Readonly<Record<string, unknown>> | undefined, isTopLevel: boolean) {
    const type = fields?.["type"];
    if (typeof type !== "string" || !isStepType(type) || !holdsStepsOfType(type)) {
        return undefined;
    }
    return isTopLevel || canStandInside(type) ? type : undefined;
}

// The path of the first step holding a list of steps deeper than `maximumDepth`, by the frame depth
// rule the policy gate applies too, or undefined. It looks only at steps that hold steps, without
// recursion, so even a plan nested thousands deep is measured cheaply and before the parser walks
// it.
export function tooDeepFrame(input: unknown, maximumDepth: number): string | undefined {
    const pending: PendingList[] = [
        { steps: plainFields(input)?.["steps"], path: "$.steps", depth: 0, topLevel: true },
    ];
    for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (!Array.isArray(next.steps)) {
            continue;
        }
        const list: readonly unknown[] = next.steps;
        for (const [index, step] of list.entries()) {
            const fields = plainFields(step);
            const type = holdingTypeOf(fields, next.topLevel);
            if (type === undefined) {
                continue;
            }
            const path = `${next.path}[${index}]`;
            const depth = frameDepthInside(type, next.depth);
            if (isDeeperThanAllowed(depth, maximumDepth)) {
                return path;
            }
            pending.push({
                steps: fields?.["steps"],
                path: `${path}.steps`,
                depth,
                topLevel: false,
            });
        }
    }
    return undefined;
}
