// How the parser reads one step type, once the step's fields have been checked against its type's
// fact: every step type has a reader, so a new type does not compile until someone writes one.
import type { Locator, StepByType, StepType } from "@revisum/contracts";
import type { Parsed } from "../../plan-decoders.ts";
import { readLocator } from "../locators/ReadLocator.ts";
import type { ParseContext } from "../ParseContext.ts";

// A step's fields, each one its type allows and every required one there.
export type StepFieldsRead = Readonly<Record<string, unknown>>;

export type StepReader<Type extends StepType> = (
    step: StepFieldsRead,
    path: string,
    context: ParseContext,
) => Parsed<StepByType[Type]>;

export type StepReaderTable<Types extends StepType = StepType> = {
    readonly [Type in Types]: StepReader<Type>;
};

// The element a step acts on or checks.
export const readStepLocator = (
    step: StepFieldsRead,
    path: string,
    context: ParseContext,
): Parsed<Locator> => readLocator(step["locator"], `${path}.locator`, context);
