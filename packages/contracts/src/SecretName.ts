import type { Brand } from "./brand.ts";

// The name of a secret the trusted project declares. A plan names a secret; it never holds one.
export type SecretName = Brand<string, "SecretName">;
export type SecretReference = { readonly secretName: SecretName };
