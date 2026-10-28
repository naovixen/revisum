// The policy gate's shared types. Parsing stops invalid plans; the policy gate narrows what a
// valid plan may do. It checks a plan before a run starts (origins, limits, and clicks on controls
// whose names mark them as irreversible), and the driver asks it again just before every action,
// once the page shows which element the action would touch.
// See docs/specs/SPEC-03-policy-gate.md.
import type { Locale } from './target.ts';
import type { Plan } from './plan.ts';

// Why the gate denied a plan or an action. Each rule has a heading in docs/errors.md.
export type PolicyRuleId =
  | 'irreversible-action' | 'irreversible-submit' | 'destructive-navigation' | 'irreversible-dialog'
  | 'unnamed-control' | 'no-locale-patterns' | 'undeclared-origin' | 'production-origin' | 'over-limit'
  | 'side-effect-in-proposal';

// A plan the policy gate cleared for its targets. Only the gate makes one, and run() takes nothing
// else. It is branded with a key of its own, not with Brand, so it stays a narrower Plan: a second
// `__brand` would conflict with the Plan brand and reduce the type to never.
export type Authorised = Plan & { readonly __authorisedBy: 'policy-gate' };

// What the gate decided about a whole plan. The step index is the first offending step (a step
// inside a frame counts as the frame's step), or null when the rule concerns the whole plan.
export type PolicyDecision =
  | { readonly kind: 'allow'; readonly plan: Authorised }
  | { readonly kind: 'deny'; readonly rule: PolicyRuleId; readonly stepIndex: number | null };

// What the gate's runtime guard decided about one action, just before it is performed.
export type GuardVerdict =
  | { readonly kind: 'allow' }
  | { readonly kind: 'deny'; readonly rule: PolicyRuleId; readonly stepIndex: number };

// Words, per locale, whose appearance as a whole word in a control's name, a form's submit
// control or a dialog's text marks the action as irreversible. Matched case-insensitively. The
// trusted project adds these to the engine's own sets.
export type IrreversiblePatterns = Readonly<Partial<Record<Locale, readonly string[]>>>;
