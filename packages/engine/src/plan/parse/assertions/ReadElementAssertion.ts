// A check on an element: its state, its text, how many match, a link's target, or, once the
// project enables DOM checks, a class, a computed style or an attribute.
import {
    DOM_CHECK_KINDS,
    DomCheckKind,
    ElementAssertionKind,
    ELEMENT_STATE_KINDS,
    literalText,
    type ElementAssertion,
    type TextOrValue,
} from "@revisum/contracts";
import type { ReadableInput } from "../../../decoding/ReadableCopy.ts";
import { INVALID, isOneOf, readInteger, readOneOf, type Parsed } from "../ReadRecord.ts";
import {
    ATTRIBUTE_NAME,
    CLASS_TOKEN,
    DOM_CHECKS_FEATURE,
    ELEMENT_KINDS,
    MAXIMUM_EXPECTED_COUNT,
    MAXIMUM_STYLE_VALUE_LENGTH,
    MAXIMUM_URL_LENGTH,
    STYLE_PROPERTY,
} from "../../schema/PlanFields.ts";
import { readFields } from "../../ReadFields.ts";
import { knownField } from "../KnownField.ts";
import { isFeatureEnabledElseRefused, type ParseContext } from "../ParseContext.ts";
import { readLiteralName } from "../text/ReadLiteralName.ts";
import { readExpectedText, readTextOrValue } from "../text/ReadTextOrValue.ts";
import { isComparedUrlElseRefused } from "../text/ReadUrl.ts";
import { readWrittenText } from "../text/ReadWrittenText.ts";
import { readAssertionHead, readKindAlone, readKindAndValue } from "./ReadAssertionHead.ts";

// A link target for hrefEquals: a compared URL, or a value reference whose text is known only at
// run time.
function readLinkTarget(input: unknown, path: string, context: ParseContext): Parsed<TextOrValue> {
    const value = readTextOrValue(input, path, context, MAXIMUM_URL_LENGTH);
    if (value === INVALID) {
        return INVALID;
    }
    const literal = literalText(value);
    return literal === undefined || isComparedUrlElseRefused(literal, path, context)
        ? value
        : INVALID;
}

const readAttributeName = (context: ParseContext) => (input: unknown, path: string) =>
    readLiteralName(input, path, context, ATTRIBUTE_NAME);

// A DOM check: one class token, a lowercase style property and the computed value expected, or an
// attribute by its lowercase name. Only an attribute's expected value may be a value reference; it
// may be empty, since an attribute set to "" is a real state.
function readDomCheck(
    kind: DomCheckKind,
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<ElementAssertion> {
    switch (kind) {
        case DomCheckKind.HasClass:
        case DomCheckKind.LacksClass:
            return readKindAndValue(input, path, context, kind, (value, valuePath) =>
                readLiteralName(value, valuePath, context, CLASS_TOKEN),
            );
        case DomCheckKind.ComputedStyleEquals: {
            const fields = readFields(input, path, context.issues, {
                kind: knownField(kind),
                property: (property: unknown, propertyPath: string) =>
                    readLiteralName(property, propertyPath, context, STYLE_PROPERTY),
                value: (value: unknown, valuePath: string) =>
                    readWrittenText(value, valuePath, context, MAXIMUM_STYLE_VALUE_LENGTH),
            });
            return fields === INVALID
                ? INVALID
                : { kind, property: fields.property, value: fields.value };
        }
        case DomCheckKind.AttributeEquals: {
            const longest = context.rules.limits.maximumTextLength;
            const fields = readFields(input, path, context.issues, {
                kind: knownField(kind),
                name: readAttributeName(context),
                value: (value: unknown, valuePath: string) =>
                    readTextOrValue(value, valuePath, context, longest, 0),
            });
            return fields === INVALID ? INVALID : { kind, name: fields.name, value: fields.value };
        }
        case DomCheckKind.AttributeAbsent: {
            const fields = readFields(input, path, context.issues, {
                kind: knownField(kind),
                name: readAttributeName(context),
            });
            return fields === INVALID ? INVALID : { kind, name: fields.name };
        }
    }
}

export function readElementAssertion(
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<ElementAssertion> {
    const head = readAssertionHead(input, path, context);
    if (head === INVALID) {
        return INVALID;
    }
    const kindPath = `${path}.kind`;
    const kind = readOneOf(head["kind"], kindPath, context.issues, ELEMENT_KINDS);
    if (kind === INVALID) {
        return INVALID;
    }
    if (isOneOf(DOM_CHECK_KINDS, kind)) {
        return isFeatureEnabledElseRefused(DOM_CHECKS_FEATURE, kindPath, context)
            ? readDomCheck(kind, input, path, context)
            : INVALID;
    }
    if (isOneOf(ELEMENT_STATE_KINDS, kind)) {
        return readKindAlone(input, path, context, kind);
    }
    if (kind === ElementAssertionKind.CountEquals) {
        return readKindAndValue(input, path, context, kind, (value, valuePath, issues) =>
            readInteger(value, valuePath, issues, 0, MAXIMUM_EXPECTED_COUNT),
        );
    }
    if (kind === ElementAssertionKind.HrefEquals) {
        return readKindAndValue(input, path, context, kind, (value, valuePath) =>
            readLinkTarget(value, valuePath, context),
        );
    }
    return readKindAndValue(input, path, context, kind, (value, valuePath) =>
        readExpectedText(value, valuePath, context),
    );
}
