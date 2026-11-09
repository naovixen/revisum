import { environmentSecretStore, type SecretStore } from "@revisum/engine";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// A secret store holding no secrets, so every name resolves to null, unless a test plants some.
export function fakeSecretStore(
    secrets: Readonly<Record<string, string>> = {},
    overrides: Partial<SecretStore> = {},
): Recorded<SecretStore> {
    const defaults: Required<SecretStore> = environmentSecretStore(secrets);
    return recordCalls({ ...defaults, ...overrides });
}
