// The other ports a run needs from outside: time, randomness, artefact storage, redaction and
// the optional AI helpers. AI output is typed `unknown`, so it is usable only after parsing.
import type { DraftRequest } from './plan-drafts.ts';

export interface Clock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}
export interface Random {
  readonly seed: number;
  next(): number;
}

export type ArtifactReference = { readonly name: string; readonly mediaType: string; readonly sha256: string; readonly bytes: number };
export interface ArtifactStore {
  put(name: string, bytes: Uint8Array, mediaType: string): Promise<ArtifactReference>;
}

export interface Redactor {
  // Replaces every personal-data pattern in free text.
  text(value: string): string;
  // Selectors whose elements are masked in screenshots and whose text is never logged.
  readonly selectors: readonly string[];
}

export type SpecInput = { readonly specReference: string; readonly text: string };

// Returns unknown: the only way to use the output is to pass it through the plan parser.
export interface AiPlanner {
  propose(spec: SpecInput): Promise<unknown>;
}
// The draft command's planner. It answers with the planner's reply as received, typed unknown: the
// engine decodes it, and only its text, once bounded, becomes a draft. A call that fails (the
// network, the egress proxy or the planner's status) rejects, carrying nothing from the reply.
export interface DraftPlanner {
  draft(request: DraftRequest): Promise<unknown>;
}
// Returns unknown: the output is only ever stored as a suggestion beside the deterministic draft.
export interface AiWriter {
  suggest(draft: string): Promise<unknown>;
}

// How strongly a run is isolated. isolated: the run's network egress is enforced and it can be
// replayed. host: it ran on the host, with no egress enforcement and no replay claim.
export const GuaranteeLevel = {
  Isolated: 'isolated',
  Host: 'host',
} as const;
export type GuaranteeLevel = (typeof GuaranteeLevel)[keyof typeof GuaranteeLevel];

// Says how strongly a run is isolated. A run reads it as it seals its result, once its steps have
// ended, since a runner's level can fall to 'host' only when the proxy's record proves incomplete.
// A run on the host is handed one that always says 'host'; an isolated runner's handle is one.
export interface RunIsolation {
  guaranteeLevel(): GuaranteeLevel;
}
