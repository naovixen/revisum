// Plan drafts: what every authoring route produces, whether a person writes a file, a customer's
// own AI writes one, or a core route (the draft command, a ticket, the builder, the recorder, the
// chat) drafts one. A draft is text, never a Plan: only the engine's plan parser makes a Plan, and
// the engine's admitDraft is the one door from a draft to it.
//
// A draft's provenance says where it came from. It is recorded on the audit event and shown, but
// never trusted: it changes no gate, approval or metric.
// See docs/specs/SPEC-28-plan-authoring.md.

// Every route a draft may come by.
export const PLAN_SOURCES = ['hand-written', 'customer-llm', 'draft-command', 'ticket', 'builder', 'recorder', 'chat'] as const;
export type PlanSource = (typeof PLAN_SOURCES)[number];

// The sources an author may name for a file. The others are core's own routes, which only core
// can record.
export const DECLARABLE_PLAN_SOURCES = ['hand-written', 'customer-llm'] as const satisfies readonly PlanSource[];

// core-recorded: core produced the draft itself. declared: an author named the source of a file;
// it is never checked or trusted.
export type ProvenanceBasis = 'core-recorded' | 'declared';

export type PlanProvenance = {
  readonly source: PlanSource;
  readonly basis: ProvenanceBasis;
  // A spec path, issue id or session id that the draft came from; never content.
  readonly reference?: string;
};

export type PlanFormat = 'json' | 'text';

// The text of a plan in one of its two forms. `provenance` is the source the caller declares; left
// out, the draft is hand-written, basis declared.
export type PlanDraft = { readonly format: PlanFormat; readonly content: string; readonly provenance?: PlanProvenance };
