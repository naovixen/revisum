// A plan step as a cleared run runs it: the plan's own step, except that a fill of a secret carries
// the secret preflight resolved for it, inside frames and second tabs too. Only secret resolution
// makes these, from the plan the run was cleared for, so a fill never looks its secret up and
// cannot miss it.
import type { Secret, SecretReference, Step, StepType } from "@revisum/contracts";

type FillStep = Extract<Step, { type: typeof StepType.Fill }>;
type FrameStep = Extract<Step, { type: typeof StepType.Frame }>;
type NewTabStep = Extract<Step, { type: typeof StepType.NewTab }>;

// A fill of text, a value reference or several lines.
export type TextFillStep = Omit<FillStep, "value"> & {
    readonly value: Exclude<FillStep["value"], SecretReference>;
};

// A fill of a secret: the plan's reference, which the runtime guard reads as before, and the secret
// itself, opaque, for the driver to type.
export type SecretFillStep = Omit<FillStep, "value"> & {
    readonly value: SecretReference;
    readonly secret: Secret;
};

export type RunFillStep = TextFillStep | SecretFillStep;

export type RunStep =
    | Exclude<Step, { type: typeof StepType.Fill | typeof StepType.Frame | typeof StepType.NewTab }>
    | RunFillStep
    | (Omit<FrameStep, "steps"> & { readonly steps: readonly RunStep[] })
    | (Omit<NewTabStep, "steps"> & { readonly steps: readonly RunStep[] });
