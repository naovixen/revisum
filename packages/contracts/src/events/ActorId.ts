import type { Brand } from "../foundation/Brand.ts";

// A keyed hash (HMAC) of the identity under the customer's key: pseudonymous, never the raw identity.
export type ActorId = Brand<string, "ActorId">;
