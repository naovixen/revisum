import { defaultRedactor, type Redactor } from "@revisum/engine";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// The real redactor: a test that stood in a weaker one would hide what a run leaks.
export const fakeRedactor = (overrides: Partial<Redactor> = {}): Recorded<Redactor> =>
    recordCalls({ ...defaultRedactor(), ...overrides });
