// The policy gate's shared types. Parsing stops invalid plans; the policy gate narrows what a
// valid plan may do. It checks a plan before a run starts (origins, limits, and clicks on controls
// whose names mark them as irreversible), and the driver asks it again just before every action,
// once the page shows which element the action would touch.
import type { Locale } from "./Target.ts";

// Why the gate denied a plan or an action. Each rule has a heading in docs/errors.md.
export const PolicyRuleId = {
    IrreversibleAction: "irreversible-action",
    IrreversibleSubmit: "irreversible-submit",
    DestructiveNavigation: "destructive-navigation",
    IrreversibleDialog: "irreversible-dialog",
    UnnamedControl: "unnamed-control",
    NoLocalePatterns: "no-locale-patterns",
    UndeclaredOrigin: "undeclared-origin",
    ProductionOrigin: "production-origin",
    OverLimit: "over-limit",
    SideEffectInProposal: "side-effect-in-proposal",
    InlineScriptInProposal: "inline-script-in-proposal",
    UnsafeFeatureDisabled: "unsafe-feature-disabled",
    UndeclaredSecret: "undeclared-secret",
} as const;
export type PolicyRuleId = (typeof PolicyRuleId)[keyof typeof PolicyRuleId];

export const PolicyVerdictKind = {
    Allow: "allow",
    Deny: "deny",
} as const;
export type PolicyVerdictKind = (typeof PolicyVerdictKind)[keyof typeof PolicyVerdictKind];

// The gate's denial of a whole plan. The step index is the first offending step (a step inside a
// frame counts as the frame's step), or null when the rule concerns the whole plan. A denial the
// audit sink failed to record says so with `unrecorded`, so a lost audit record changes the outcome
// instead of passing silently. What the gate gives for a plan it allows is the engine's: the run it
// cleared, with the project and standing it was judged under.
export type PlanDenial = {
    readonly kind: typeof PolicyVerdictKind.Deny;
    readonly rule: PolicyRuleId;
    readonly stepIndex: number | null;
    readonly unrecorded?: true;
};

// What the gate's runtime guard decided about one action, just before it is performed. As above,
// `unrecorded` marks a denial the audit sink failed to record.
export type GuardVerdict =
    | { readonly kind: typeof PolicyVerdictKind.Allow }
    | {
          readonly kind: typeof PolicyVerdictKind.Deny;
          readonly rule: PolicyRuleId;
          readonly stepIndex: number;
          readonly unrecorded?: true;
      };

// Words, per locale, whose appearance as a whole word in a control's name, a form's submit
// control or a dialog's text marks the action as irreversible. Matched case-insensitively, after
// compatibility forms are folded, invisible format characters removed and camelCase words split.
// The trusted project adds these to the engine's own sets.
export type IrreversiblePatterns = Readonly<Partial<Record<Locale, readonly string[]>>>;
