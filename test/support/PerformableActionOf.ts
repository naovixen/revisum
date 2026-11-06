// Turns a parsed step or locator into what a driver's ports take, as the engine does before it calls
// one. A test that calls a driver directly hands it only literal text: a value reference left in the
// step is a broken test, so it throws.
import {
    literalLocator,
    literalText,
    StructuralLocatorKind,
    type ActionStep,
    type DownloadStep,
    type Locator,
    type PerformableAction,
    type ResolvedDownloadStep,
    type ResolvedLocator,
    type SafeText,
    type Secret,
    type TextOrValue,
} from "@revisum/engine";

function literal(text: TextOrValue): SafeText {
    const found = literalText(text);
    if (found === undefined) {
        throw new Error(
            `a value reference was left in a step a test hands a driver: ${JSON.stringify(text)}`,
        );
    }
    return found;
}

// The locator with its texts, and those of the locators it is inside, as literal text.
export function resolvedLocatorOf(locator: Locator): ResolvedLocator {
    if (locator.by !== StructuralLocatorKind.Css && locator.by !== StructuralLocatorKind.Xpath) {
        const semantic = literalLocator(locator);
        if (semantic === undefined) {
            throw new Error(`a value reference was left in a locator: ${JSON.stringify(locator)}`);
        }
        return semantic;
    }
    const optional = {
        ...(locator.hasText === undefined ? {} : { hasText: literal(locator.hasText) }),
        ...(locator.inside === undefined ? {} : { inside: resolvedLocatorOf(locator.inside) }),
        ...(locator.position === undefined ? {} : { position: locator.position }),
    };
    return locator.by === StructuralLocatorKind.Css
        ? { by: StructuralLocatorKind.Css, selector: locator.selector, ...optional }
        : { by: StructuralLocatorKind.Xpath, expression: locator.expression, ...optional };
}

// The action as a driver performs it. A fill of a secret reference needs its secret, which the test
// gives as the engine would; a fill of one without it is a broken test.
export function performableActionOf(
    step: Exclude<ActionStep, DownloadStep>,
    secret?: Secret,
): PerformableAction {
    switch (step.type) {
        case "dialog":
            return step.expectText === undefined
                ? { type: step.type, action: step.action }
                : { type: step.type, action: step.action, expectText: literal(step.expectText) };
        case "click":
        case "hover":
            return { type: step.type, locator: resolvedLocatorOf(step.locator) };
        case "upload":
            return {
                type: step.type,
                locator: resolvedLocatorOf(step.locator),
                fixture: step.fixture,
            };
        case "press":
            return {
                type: step.type,
                locator: resolvedLocatorOf(step.locator),
                key: step.key,
                ...(step.modifiers === undefined ? {} : { modifiers: step.modifiers }),
            };
        case "select":
            return {
                type: step.type,
                locator: resolvedLocatorOf(step.locator),
                option: literal(step.option),
            };
        case "fill":
            return {
                type: step.type,
                locator: resolvedLocatorOf(step.locator),
                value: fillValueOf(step, secret),
            };
    }
}

function fillValueOf(
    step: Extract<ActionStep, { type: "fill" }>,
    secret: Secret | undefined,
): Extract<PerformableAction, { type: "fill" }>["value"] {
    const value = step.value;
    if (typeof value === "object" && "secretName" in value) {
        if (secret === undefined || secret.name !== value.secretName) {
            throw new Error(`a fill of ${value.secretName} was handed no secret of that name`);
        }
        return { secret };
    }
    if (typeof value === "object" && "lines" in value) {
        return { lines: value.lines.map(literal) };
    }
    return literal(value);
}

export const resolvedDownloadOf = (step: DownloadStep): ResolvedDownloadStep => ({
    type: step.type,
    name: step.name,
    locator: resolvedLocatorOf(step.locator),
});
