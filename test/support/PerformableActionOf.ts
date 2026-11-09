// Turns a parsed step or locator into what a driver's ports take, by the engine's own resolution of
// literal steps. A test that calls a driver directly hands it only literal text: a value reference
// left in the step is a broken test, so it throws.
import {
    DEFAULT_LIMITS,
    FillValueKind,
    literalText,
    resolveLiteralActionStep,
    resolveLiteralLocator,
    type ActionStep,
    type DownloadStep,
    type FillValue,
    type Locator,
    type PerformableAction,
    type ResolvedActionStep,
    type ResolvedDownloadStep,
    type ResolvedLocator,
    type Result,
    type Secret,
    type StepErrorCode,
} from "@revisum/engine";
import { StepType } from "@revisum/contracts";

function resolvedOrThrow<Value>(resolved: Result<Value, StepErrorCode>, what: unknown): Value {
    if (!resolved.ok) {
        throw new Error(
            `a step a test hands a driver did not resolve as literal text (${resolved.error}): ${JSON.stringify(what)}`,
        );
    }
    return resolved.value;
}

// The locator with its texts, and those of the locators it is inside, as literal text.
export const resolvedLocatorOf = (locator: Locator): ResolvedLocator =>
    resolvedOrThrow(resolveLiteralLocator(locator, DEFAULT_LIMITS), locator);

// The action as a driver performs it. A fill of a secret reference needs its secret, which the test
// gives as the engine would; a fill of one without it is a broken test.
export function performableActionOf(
    step: Exclude<ActionStep, DownloadStep>,
    secret?: Secret,
): PerformableAction {
    if (step.type === StepType.Dialog) {
        if (step.expectText === undefined) {
            return { type: step.type, action: step.action };
        }
        const expectText = literalText(step.expectText);
        if (expectText === undefined) {
            throw new Error(
                `a value reference was left in a dialog step a test hands a driver: ${JSON.stringify(step)}`,
            );
        }
        return { type: step.type, action: step.action, expectText };
    }
    const resolved = resolvedOrThrow(resolveLiteralActionStep(step, DEFAULT_LIMITS), step);
    if (resolved.type !== StepType.Fill) {
        return resolved;
    }
    return {
        type: resolved.type,
        locator: resolved.locator,
        value: fillValueOf(resolved.value, secret),
    };
}

function fillValueOf(
    value: Extract<ResolvedActionStep, { type: "fill" }>["value"],
    secret: Secret | undefined,
): FillValue {
    if (typeof value === "string") {
        return { kind: FillValueKind.Text, text: value };
    }
    if ("lines" in value) {
        return { kind: FillValueKind.Lines, lines: value.lines };
    }
    if (secret === undefined || secret.name !== value.secretName) {
        throw new Error(`a fill of ${value.secretName} was handed no secret of that name`);
    }
    return { kind: FillValueKind.Secret, secret };
}

export const resolvedDownloadOf = (step: DownloadStep): ResolvedDownloadStep => ({
    type: step.type,
    name: step.name,
    locator: resolvedLocatorOf(step.locator),
});
