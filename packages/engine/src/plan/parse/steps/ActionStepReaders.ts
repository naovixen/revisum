// Steps that act on the page: clicks, hovers, fills, selections, uploads, key presses and answers
// to dialogs.
import {
    DIALOG_ACTIONS,
    KEYS,
    MODIFIERS,
    PlanErrorCode,
    StepType,
    type Modifier,
} from "@revisum/contracts";
import { namesSensitiveField } from "../../literal-secrets.ts";
import {
    allValid,
    INVALID,
    readList,
    readOneOf,
    type Issues,
    type Parsed,
} from "../../plan-decoders.ts";
import { MAXIMUM_MODIFIERS } from "../../plan-grammar.ts";
import { optionalField, readFields } from "../../ReadFields.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { readDeclared } from "../declarations/ReadDeclared.ts";
import { knownField } from "../KnownField.ts";
import { readLocator } from "../locators/ReadLocator.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { holdsLiteralText, readFillValue } from "../text/ReadFillValue.ts";
import { readTextOrValue } from "../text/ReadTextOrValue.ts";
import { readStepLocator, type StepFieldsRead, type StepReaderTable } from "./StepReader.ts";

function readModifiers(input: unknown, path: string, issues: Issues): Parsed<readonly Modifier[]> {
    const written = readList(input, path, issues, MAXIMUM_MODIFIERS);
    if (written === INVALID) {
        return INVALID;
    }
    const modifiers = written.map((modifier, index) =>
        readOneOf(modifier, `${path}[${index}]`, issues, MODIFIERS),
    );
    if (!allValid(modifiers)) {
        return INVALID;
    }
    if (new Set(modifiers).size !== modifiers.length) {
        return refuse(issues, PlanErrorCode.Duplicate, path);
    }
    return modifiers;
}

const readOption = (
    step: StepFieldsRead<typeof StepType.Select>,
    path: string,
    context: ParseContext,
) =>
    readTextOrValue(
        step.option,
        `${path}.option`,
        context,
        context.rules.limits.maximumTextLength,
    );

export const ACTION_STEP_READERS: StepReaderTable<StepTypeIn<typeof StepSection.Actions>> = {
    click(step, path, context) {
        const locator = readStepLocator(step, path, context);
        return locator === INVALID ? INVALID : { type: StepType.Click, locator };
    },
    hover(step, path, context) {
        const locator = readStepLocator(step, path, context);
        return locator === INVALID ? INVALID : { type: StepType.Hover, locator };
    },
    fill(step, path, context) {
        const valuePath = `${path}.value`;
        const parts = [
            readStepLocator(step, path, context),
            readFillValue(step.value, valuePath, context),
        ] as const;
        if (!allValid(parts)) {
            return INVALID;
        }
        const [locator, value] = parts;
        // A password or token typed as literal text would put a secret in the plan. Clearing the
        // field with empty text holds no secret, so it stays allowed.
        if (holdsLiteralText(value) && namesSensitiveField(locator)) {
            return refuse(context.issues, PlanErrorCode.LiteralSecret, valuePath);
        }
        return { type: StepType.Fill, locator, value };
    },
    select(step, path, context) {
        const parts = [
            readStepLocator(step, path, context),
            readOption(step, path, context),
        ] as const;
        return allValid(parts)
            ? { type: StepType.Select, locator: parts[0], option: parts[1] }
            : INVALID;
    },
    upload(step, path, context) {
        const parts = [
            readStepLocator(step, path, context),
            readDeclared(step.fixture, `${path}.fixture`, context, context.rules.fixtures),
        ] as const;
        return allValid(parts)
            ? { type: StepType.Upload, locator: parts[0], fixture: parts[1] }
            : INVALID;
    },
    press(step, path, context) {
        return readFields(step, path, context.issues, {
            type: knownField(StepType.Press),
            locator: (locator: unknown, locatorPath: string) =>
                readLocator(locator, locatorPath, context),
            key: (key: unknown, keyPath: string) => readOneOf(key, keyPath, context.issues, KEYS),
            modifiers: optionalField((modifiers: unknown, modifiersPath: string) =>
                readModifiers(modifiers, modifiersPath, context.issues),
            ),
        });
    },
    dialog(step, path, context) {
        return readFields(step, path, context.issues, {
            type: knownField(StepType.Dialog),
            action: (action: unknown, actionPath: string) =>
                readOneOf(action, actionPath, context.issues, DIALOG_ACTIONS),
            expectText: optionalField((expectText: unknown, expectTextPath: string) =>
                readTextOrValue(
                    expectText,
                    expectTextPath,
                    context,
                    context.rules.limits.maximumTextLength,
                ),
            ),
        });
    },
};
