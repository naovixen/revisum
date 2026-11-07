import type { PlanError } from "./PlanError.ts";

// A plan the parser rejected, so no run started.
export type Rejected = { readonly state: "Rejected"; readonly errors: readonly PlanError[] };
