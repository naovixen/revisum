// A plan step as a cleared run runs it: the plan's own step, except that a fill of a secret carries
// the secret preflight resolved for it and a navigate says how its page loads, inside frames and
// second tabs too. Only secret resolution makes these, from the plan the run was cleared for, so a
// fill never looks its secret up and a navigate has no default to apply.
import type { NavigateOptions, Secret, SecretReference, Step, StepType } from "@revisum/contracts";

type FillStep = Extract<Step, { type: typeof StepType.Fill }>;
type NavigateStep = Extract<Step, { type: typeof StepType.Navigate }>;
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

// A navigate keeps the plan's step as written, whose absent `scripts` the plan's hash relies on, and
// says beside it how the page loads.
export type RunNavigateStep = NavigateStep & { readonly navigation: NavigateOptions };

export type RunStep =
    | Exclude<
          Step,
          {
              type:
                  | typeof StepType.Fill
                  | typeof StepType.Navigate
                  | typeof StepType.Frame
                  | typeof StepType.NewTab;
          }
      >
    | RunFillStep
    | RunNavigateStep
    | (Omit<FrameStep, "steps"> & { readonly steps: readonly RunStep[] })
    | (Omit<NewTabStep, "steps"> & { readonly steps: readonly RunStep[] });

// Each step type's step as a run runs it, for tables keyed by StepType. A fill is either kind.
export type RunStepByType = { readonly [TypedStep in RunStep as TypedStep["type"]]: TypedStep };

// A step that holds steps of its own: a frame, or a second tab.
export type ContainerRunStep = Extract<RunStep, { readonly steps: readonly RunStep[] }>;
