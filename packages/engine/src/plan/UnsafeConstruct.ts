// What of each kind of step uses an unsafe feature, and where. The step facts table names one of
// these for every step type. Each construct is placed at the field that names its feature, the same
// path the plan parser refuses a disabled one at.
import {
    RememberElementRead, StructuralLocatorKind, DOM_CHECK_KINDS,
    type DatabaseCommandStep,
    type Locator,
    type PageScriptStep,
    type StepByType,
    type UnsafeFeature,
} from "@revisum/contracts";
import { isInlineChoice } from "./IsInlineChoice.ts";
import { isOneOf } from "./parse/ReadRecord.ts";
import {
    DATABASE_COMMAND_FEATURE,
    DOM_CHECKS_FEATURE,
    INLINE_SCRIPT_FEATURE,
    LOCATOR_FEATURES,
    NAMED_SCRIPT_FEATURE,
} from "./schema/PlanFields.ts";

// One use of an unsafe feature, at the JSON path of the field that names it.
export type UnsafeConstruct = { readonly feature: UnsafeFeature; readonly path: string };

// A locator's own feature, then those of the locators it is evaluated inside.
function locatorConstructs(locator: Locator, path: string): UnsafeConstruct[] {
    if (locator.by !== StructuralLocatorKind.Css && locator.by !== StructuralLocatorKind.Xpath) {
        return [];
    }
    const own = { feature: LOCATOR_FEATURES[locator.by], path: `${path}.by` };
    return locator.inside === undefined
        ? [own]
        : [own, ...locatorConstructs(locator.inside, `${path}.inside`)];
}

export function noUnsafeConstructs(): readonly UnsafeConstruct[] {
    return [];
}

// A frame is one of these: the steps inside it are visited on their own.
export function locatorStepConstructs(
    step: { readonly locator: Locator },
    path: string,
): readonly UnsafeConstruct[] {
    return locatorConstructs(step.locator, `${path}.locator`);
}

export function expectStepConstructs(
    step: StepByType["expect"],
    path: string,
): readonly UnsafeConstruct[] {
    const check = isOneOf(DOM_CHECK_KINDS, step.assert.kind)
        ? [{ feature: DOM_CHECKS_FEATURE, path: `${path}.assert.kind` }]
        : [];
    return [...locatorConstructs(step.locator, `${path}.locator`), ...check];
}

export function rememberStepConstructs(
    step: StepByType["remember"],
    path: string,
): readonly UnsafeConstruct[] {
    if (!("element" in step.from)) {
        return [];
    }
    const read =
        step.from.read === RememberElementRead.Attribute
            ? [{ feature: DOM_CHECKS_FEATURE, path: `${path}.from.read` }]
            : [];
    return [...read, ...locatorConstructs(step.from.element, `${path}.from.element`)];
}

export function pageScriptStepConstructs(
    step: PageScriptStep,
    path: string,
): readonly UnsafeConstruct[] {
    return [
        isInlineChoice(step.script)
            ? { feature: INLINE_SCRIPT_FEATURE, path: `${path}.script.inline` }
            : { feature: NAMED_SCRIPT_FEATURE, path: `${path}.type` },
    ];
}

export function databaseStepConstructs(
    step: DatabaseCommandStep,
    path: string,
): readonly UnsafeConstruct[] {
    return [{ feature: DATABASE_COMMAND_FEATURE, path: `${path}.type` }];
}
