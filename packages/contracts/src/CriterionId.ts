import type { Brand } from "./brand.ts";

// The id of the acceptance criterion an assertion checks, from the user's own spec, such as "AC-3".
export type CriterionId = Brand<string, "CriterionId">;
