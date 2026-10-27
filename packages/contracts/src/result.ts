// Success and failure as values, never exceptions, so every caller has to handle both.
// See docs/specs/SPEC-27-shared-types-and-events.md.
export type Success<Value> = { readonly ok: true; readonly value: Value };
export type Failure<Problem> = { readonly ok: false; readonly error: Problem };
export type Result<Value, Problem> = Success<Value> | Failure<Problem>;

export const success = <Value>(value: Value): Success<Value> => ({ ok: true, value });
export const failure = <Problem>(error: Problem): Failure<Problem> => ({ ok: false, error });
