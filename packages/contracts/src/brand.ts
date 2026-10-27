// A branded type: a value of Brand<string, 'Plan'> is a string that the module owning the 'Plan'
// brand has checked. Only that module's parser may create one, so "already validated" shows in the
// type. Elsewhere, a cast to a branded type is a review failure.
// See docs/specs/SPEC-27-shared-types-and-events.md.
export type Brand<Value, Name extends string> = Value & { readonly __brand: Name };
