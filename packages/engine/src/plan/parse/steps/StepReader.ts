// How the parser reads one step type, once the step's fields have been checked against its type's
// fact: every step type has a reader, so a new type does not compile until someone writes one, and
// a reader names every field of its type, so a new field does not compile until its reader reads it.
import type { Locator, StepByType, StepType } from "@revisum/contracts";
import type { ReadableInput, ReadableRecord } from "../../../decoding/ReadableCopy.ts";
import type { Parsed } from "../../../decoding/ReadRecord.ts";
import type { FieldOf } from "../../StepFacts.ts";
import { readLocator } from "../locators/ReadLocator.ts";
import type { ParseContext } from "../ParseContext.ts";

// A step's fields, each one its type allows and every required one there. Typed by the names its
// type's steps have, so a reader can't read a field its type has no name for.
export type StepFieldsRead<Type extends StepType = StepType> = ReadableRecord &
    Readonly<Partial<Record<FieldOf<Type>, ReadableInput>>>;

// The fields a step may leave out.
type OptionalFieldOf<Step> = {
    [Field in keyof Step]-?: Partial<Pick<Step, Field>> extends Pick<Step, Field> ? Field : never;
}[keyof Step];

// Each form of a step with every field it has named, one it may leave out as undefined when it is
// left out, so a reader that forgets a field does not compile.
type EveryFieldOf<Step> = Step extends unknown
    ? { readonly [Field in Exclude<keyof Step, OptionalFieldOf<Step>>]: Step[Field] } & {
          readonly [Field in OptionalFieldOf<Step>]: Step[Field] | undefined;
      }
    : never;

// What a reader makes of a step of `Type`: every field of its type named.
export type StepRead<Type extends StepType> = EveryFieldOf<StepByType[Type]>;

export type StepReader<Type extends StepType> = (
    step: StepFieldsRead<Type>,
    path: string,
    context: ParseContext,
) => Parsed<StepRead<Type>>;

export type StepReaderTable<Types extends StepType = StepType> = {
    readonly [Type in Types]: StepReader<Type>;
};

// The step a reader made, with each field it left out as undefined left out, so a step without an
// optional field is exactly as written and hashes as it always did. The other fields keep the
// order the reader named them in.
export function withoutLeftOutFields<Type extends StepType>(
    read: StepRead<Type>,
): StepByType[Type] {
    const kept = Object.entries(read).filter(([, value]) => value !== undefined);
    // Only the fields typed as possibly undefined can be undefined, and those are the ones the
    // step type marks as optional, so what is left is a step of `Type`.
    return Object.fromEntries(kept) as StepByType[Type];
}

// A field the step may leave out: undefined when it is, otherwise read at its own path.
export const readWhenPresent = <Field extends string, Value>(
    step: { readonly [Key in Field]?: ReadableInput },
    field: Field,
    path: string,
    read: (value: ReadableInput, fieldPath: string) => Parsed<Value>,
): Parsed<Value> | undefined =>
    Object.hasOwn(step, field) ? read(step[field], `${path}.${field}`) : undefined;

// The element a step acts on or checks.
export const readStepLocator = (
    step: { readonly locator?: ReadableInput },
    path: string,
    context: ParseContext,
): Parsed<Locator> => readLocator(step.locator, `${path}.locator`, context);
