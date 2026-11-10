import { defaultRedactor, type Redactor } from "@revisum/engine";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// The real redactor: a test that stood in a weaker one would hide what a run leaks.
export function fakeRedactor(overrides: Partial<Redactor> = {}): Recorded<Redactor> {
    const defaults: Required<Redactor> = defaultRedactor();
    return recordCalls({ ...defaults, ...overrides });
}
