// The one walk over a plan's steps. Frames and second tabs hold steps of their own, and anything
// that reads every step, such as the secrets or the origins a plan names, walks them here.
import { StepType, type Step } from "@revisum/contracts";

// Where a visited step stands: the index of the step in the list the walk started from that holds
// it (itself, or the frame or second tab it is inside), and its JSON path, such as
// "$.steps[2].steps[0]".
export type StepPlace = { readonly topIndex: number; readonly path: string };

type ContainerStep = Extract<Step, { readonly steps: readonly Step[] }>;

const holdsSteps = (step: Step): step is ContainerStep =>
    step.type === StepType.Frame || step.type === StepType.NewTab;

function visitList(
    steps: readonly Step[],
    path: string,
    topIndex: number | undefined,
    visit: (step: Step, place: StepPlace) => void,
): void {
    for (const [index, step] of steps.entries()) {
        const place: StepPlace = { topIndex: topIndex ?? index, path: `${path}[${index}]` };
        visit(step, place);
        if (holdsSteps(step)) {
            visitList(step.steps, `${place.path}.steps`, place.topIndex, visit);
        }
    }
}

// Visits every step in document order: each step, then the steps inside it. `path` names the list,
// "$.steps" by default.
export function visitSteps(
    steps: readonly Step[],
    visit: (step: Step, place: StepPlace) => void,
    path = "$.steps",
): void {
    visitList(steps, path, undefined, visit);
}

// Every step in document order, those inside frames and second tabs included.
export function stepsWithin(steps: readonly Step[]): readonly Step[] {
    const found: Step[] = [];
    visitSteps(steps, (step) => {
        found.push(step);
    });
    return found;
}
