// Plan drafts: what every authoring route produces, whether a person writes a file, a customer's
// own AI writes one, or a core route (the draft command, a ticket, the builder, the recorder, the
// chat) drafts one. A draft is text, never a Plan: only the engine's plan parser makes a Plan, and
// the engine's admitDraft is the one door from a draft to it.
//
// A draft's provenance says where it came from. It is recorded on the audit event and shown, but
// never trusted: it changes no gate, approval or metric.
import type { Brand } from "../foundation/Brand.ts";
import type { PageMapEntry } from "../modes/PageMap.ts";
import type { Origin, TargetId } from "../ports/Target.ts";
import type { CriterionId } from "./CriterionId.ts";
import type { SecretName } from "./SecretName.ts";

// Every route a draft may come by.
// explore-draft is the draft command's explore mode, which drafts from a crawl of the running app.
export const PlanSource = {
    HandWritten: "hand-written",
    CustomerLlm: "customer-llm",
    DraftCommand: "draft-command",
    Ticket: "ticket",
    Builder: "builder",
    Recorder: "recorder",
    Chat: "chat",
    ExploreDraft: "explore-draft",
} as const;
export type PlanSource = (typeof PlanSource)[keyof typeof PlanSource];
export const PLAN_SOURCES: readonly PlanSource[] = Object.values(PlanSource);

// The sources an author may name for a file. The others are core's own routes, which only core
// can record.
export const DeclarablePlanSource = {
    HandWritten: PlanSource.HandWritten,
    CustomerLlm: PlanSource.CustomerLlm,
} as const;
export type DeclarablePlanSource = (typeof DeclarablePlanSource)[keyof typeof DeclarablePlanSource];
export const DECLARABLE_PLAN_SOURCES: readonly DeclarablePlanSource[] =
    Object.values(DeclarablePlanSource);

// core-recorded: core produced the draft itself. declared: an author named the source of a file;
// it is never checked or trusted.
export const ProvenanceBasis = {
    CoreRecorded: "core-recorded",
    Declared: "declared",
} as const;
export type ProvenanceBasis = (typeof ProvenanceBasis)[keyof typeof ProvenanceBasis];

export type PlanProvenance = {
    readonly source: PlanSource;
    readonly basis: ProvenanceBasis;
    // A spec path, issue id or session id that the draft came from; never content.
    readonly reference?: string;
};

export const PlanFormat = {
    Json: "json",
    Text: "text",
} as const;
export type PlanFormat = (typeof PlanFormat)[keyof typeof PlanFormat];

// The text of a plan in one of its two forms. `provenance` is the source the caller declares; left
// out, the draft is hand-written, basis declared.
export type PlanDraft = {
    readonly format: PlanFormat;
    readonly content: string;
    readonly provenance?: PlanProvenance;
};

// ---- The draft command (route c) ------------------------------------------------------------------

// One acceptance criterion of a spec: its id as the spec writes it, and the text after the id.
export type CriterionText = { readonly criterion: CriterionId; readonly text: string };

// Everything a planner may see when it drafts a plan: the criteria's text, the readable grammar's
// version, the project's declared origins and targets and, in explore mode, the crawl's page map.
// Never secrets, cookies, storage, screenshots, typed values, artefacts or any other text from the
// spec. `criteria` may be empty only when `pages` is given.
export type DraftRequest = {
    readonly criteria: readonly CriterionText[];
    readonly grammarVersion: string;
    readonly origins: readonly Origin[];
    readonly targets: readonly TargetId[];
    readonly pages?: readonly PageMapEntry[];
};

// The two request formats a planner endpoint may speak: Anthropic's Messages API, and the
// OpenAI-compatible chat completions format, which local servers such as Ollama also speak.
export const PlannerWire = {
    AnthropicMessages: "anthropic-messages",
    OpenaiChat: "openai-chat",
} as const;
export type PlannerWire = (typeof PlannerWire)[keyof typeof PlannerWire];
export const PLANNER_WIRES: readonly PlannerWire[] = Object.values(PlannerWire);

export const PlannerEndpointKind = {
    CustomerKey: "customer-key",
    Local: "local",
} as const;
export type PlannerEndpointKind = (typeof PlannerEndpointKind)[keyof typeof PlannerEndpointKind];

// The full http or https address a planner's requests are posted to, as the project parser
// checked it: a URL with no user name, password or fragment.
export type PlannerUrl = Brand<string, "PlannerUrl">;

// Where a planner's requests go, read from its url once by the project parser: the origin, the one
// origin the egress proxy allows, and the path and query each request is posted to. Neither is
// written in project.json, and the planner is left out of the project's hash.
export type PlannerAddress = { readonly origin: Origin; readonly pathAndQuery: string };

// The planner the draft command calls, declared in the trusted project.json. `url` is the full
// address the request is posted to. A customer-key endpoint is reached over https only, with the
// customer's own key, named as a secret; a local endpoint is on the loopback interface, such as a
// model served by Ollama, and may need no key.
export type PlannerEndpoint = PlannerAddress &
    (
        | {
              readonly kind: typeof PlannerEndpointKind.CustomerKey;
              readonly url: PlannerUrl;
              readonly model: string;
              readonly wire: PlannerWire;
              readonly apiKey: { readonly secretName: SecretName };
          }
        | {
              readonly kind: typeof PlannerEndpointKind.Local;
              readonly url: PlannerUrl;
              readonly model: string;
              readonly wire: PlannerWire;
              readonly apiKey?: { readonly secretName: SecretName };
          }
    );
