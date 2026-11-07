// A locator, read by a field table for each kind. The unsafe kinds, css and XPath, are read only
// once the trusted project enables them, and their selector or expression is literal plan text, so
// what a locator can match is fixed when the plan is approved.
import {
    PlanErrorCode,
    POSITION_WORDS,
    ROLES,
    STRUCTURAL_LOCATOR_KINDS,
    type Locator,
    type Position,
    type SafeText,
    type StructuralLocatorKind,
} from "@revisum/contracts";
import {
    INVALID,
    isOneOf,
    peekRecord,
    readInteger,
    readOneOf,
    type Issues,
    type Parsed,
} from "../../plan-decoders.ts";
import {
    ALL_LOCATOR_KINDS,
    LOCATOR_FEATURES,
    MAXIMUM_INSIDE_DEPTH,
    MAXIMUM_POSITION,
    MAXIMUM_SELECTOR_LENGTH,
    MAXIMUM_TEST_ID_LENGTH,
    SELECTOR_FORBIDDEN_CHARACTERS,
    LOCATOR_FIELDS,
    type LocatorKind,
    type OPTIONAL_LOCATOR_FIELDS,
} from "../../plan-grammar.ts";
import { optionalField, readFields, type OptionalField } from "../../ReadFields.ts";
import { knownField } from "../KnownField.ts";
import type { ListedFields } from "../ListedFields.ts";
import { isFeatureEnabledElseRefused, type ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readDeclared } from "../declarations/ReadDeclared.ts";
import { readTextOrValue, readWantedText } from "../text/ReadTextOrValue.ts";
import { readWrittenText } from "../text/ReadWrittenText.ts";

// The fields a locator of `Kind` has, as the grammar lists them.
type LocatorFields<Kind extends LocatorKind> = ListedFields<
    (typeof LOCATOR_FIELDS)[Kind][number],
    (typeof OPTIONAL_LOCATOR_FIELDS)[Kind][number]
>;

// Reads a locator of one kind, whose `by` has been read. `insideDepth` counts the `inside` links
// above it.
type LocatorReader = (
    input: unknown,
    path: string,
    context: ParseContext,
    insideDepth: number,
) => Parsed<Locator>;

const isStructuralKind = (kind: string): kind is StructuralLocatorKind =>
    isOneOf(STRUCTURAL_LOCATOR_KINDS, kind);

// first, last, or a 1-based index in document order.
function readPosition(input: unknown, path: string, issues: Issues): Parsed<Position> {
    if (typeof input === "string") {
        return readOneOf(input, path, issues, POSITION_WORDS);
    }
    return readInteger(input, path, issues, 1, MAXIMUM_POSITION);
}

// Left out when absent, so a plan without it hashes the same.
const POSITION: OptionalField<Position> = optionalField(readPosition);

const positioned = (position: Position | undefined): { readonly position?: Position } =>
    position === undefined ? {} : { position };

// A css selector or XPath expression: literal plan text, never a value reference (wrong_type), of 1
// to MAXIMUM_SELECTOR_LENGTH characters, on one line and with none of "{", "}", ";" and "@"
// (unsafe_text), so what it matches is fixed when the plan is approved.
function readSelectorText(input: unknown, path: string, context: ParseContext): Parsed<SafeText> {
    const text = readWrittenText(input, path, context, MAXIMUM_SELECTOR_LENGTH);
    if (text !== INVALID && SELECTOR_FORBIDDEN_CHARACTERS.test(text)) {
        return refuse(context.issues, PlanErrorCode.UnsafeText, path);
    }
    return text;
}

// The locator a css or XPath locator is evaluated inside, unless the chain is already as deep as it
// may be: then this link is refused with too_large, and nothing under it is read.
function readInside(
    input: unknown,
    path: string,
    context: ParseContext,
    insideDepth: number,
): Parsed<Locator> {
    if (insideDepth >= MAXIMUM_INSIDE_DEPTH) {
        return refuse(context.issues, PlanErrorCode.TooLarge, path);
    }
    return readLocator(input, path, context, insideDepth + 1);
}

// What a css and an XPath locator share once their selector or expression is read.
function structuralFields(context: ParseContext, insideDepth: number) {
    return {
        hasText: optionalField((input: unknown, path: string) =>
            readWantedText(input, path, context),
        ),
        inside: optionalField((input: unknown, path: string) =>
            readInside(input, path, context, insideDepth),
        ),
    };
}

const LOCATOR_READERS = {
    role(input, path, context) {
        const fields = readFields(
            input,
            path,
            context.issues,
            {
                by: knownField("role"),
                position: POSITION,
                role: (role: unknown, rolePath: string) =>
                    readOneOf(role, rolePath, context.issues, ROLES),
                name: (name: unknown, namePath: string) => readWantedText(name, namePath, context),
            } satisfies LocatorFields<"role">,
            LOCATOR_FIELDS.role,
        );
        if (fields === INVALID) {
            return INVALID;
        }
        return {
            by: fields.by,
            role: fields.role,
            name: fields.name,
            ...positioned(fields.position),
        };
    },
    label(input, path, context) {
        const fields = readFields(
            input,
            path,
            context.issues,
            {
                by: knownField("label"),
                position: POSITION,
                label: (label: unknown, labelPath: string) =>
                    readWantedText(label, labelPath, context),
            } satisfies LocatorFields<"label">,
            LOCATOR_FIELDS.label,
        );
        if (fields === INVALID) {
            return INVALID;
        }
        return { by: fields.by, label: fields.label, ...positioned(fields.position) };
    },
    text(input, path, context) {
        const fields = readFields(
            input,
            path,
            context.issues,
            {
                by: knownField("text"),
                position: POSITION,
                text: (text: unknown, textPath: string) => readWantedText(text, textPath, context),
            } satisfies LocatorFields<"text">,
            LOCATOR_FIELDS.text,
        );
        if (fields === INVALID) {
            return INVALID;
        }
        return { by: fields.by, text: fields.text, ...positioned(fields.position) };
    },
    testId(input, path, context) {
        const fields = readFields(
            input,
            path,
            context.issues,
            {
                by: knownField("testId"),
                position: POSITION,
                testId: (testId: unknown, testIdPath: string) =>
                    readTextOrValue(testId, testIdPath, context, MAXIMUM_TEST_ID_LENGTH),
                attribute: optionalField((attribute: unknown, attributePath: string) =>
                    readDeclared(attribute, attributePath, context, context.rules.testIdAttributes),
                ),
            } satisfies LocatorFields<"testId">,
            LOCATOR_FIELDS.testId,
        );
        if (fields === INVALID) {
            return INVALID;
        }
        return {
            by: fields.by,
            testId: fields.testId,
            ...(fields.attribute === undefined ? {} : { attribute: fields.attribute }),
            ...positioned(fields.position),
        };
    },
    css(input, path, context, insideDepth) {
        const fields = readFields(
            input,
            path,
            context.issues,
            {
                by: knownField("css"),
                position: POSITION,
                selector: (selector: unknown, selectorPath: string) =>
                    readSelectorText(selector, selectorPath, context),
                ...structuralFields(context, insideDepth),
            } satisfies LocatorFields<"css">,
            LOCATOR_FIELDS.css,
        );
        if (fields === INVALID) {
            return INVALID;
        }
        return {
            by: fields.by,
            selector: fields.selector,
            ...(fields.hasText === undefined ? {} : { hasText: fields.hasText }),
            ...(fields.inside === undefined ? {} : { inside: fields.inside }),
            ...positioned(fields.position),
        };
    },
    xpath(input, path, context, insideDepth) {
        const fields = readFields(
            input,
            path,
            context.issues,
            {
                by: knownField("xpath"),
                position: POSITION,
                expression: (expression: unknown, expressionPath: string) =>
                    readSelectorText(expression, expressionPath, context),
                ...structuralFields(context, insideDepth),
            } satisfies LocatorFields<"xpath">,
            LOCATOR_FIELDS.xpath,
        );
        if (fields === INVALID) {
            return INVALID;
        }
        return {
            by: fields.by,
            expression: fields.expression,
            ...(fields.hasText === undefined ? {} : { hasText: fields.hasText }),
            ...(fields.inside === undefined ? {} : { inside: fields.inside }),
            ...positioned(fields.position),
        };
    },
} satisfies Record<LocatorKind, LocatorReader>;

// A locator. `insideDepth` counts the `inside` links above it: a css or XPath locator chains at
// most MAXIMUM_INSIDE_DEPTH of them, and the one past the limit is refused, with nothing under it
// read.
export function readLocator(
    input: unknown,
    path: string,
    context: ParseContext,
    insideDepth = 0,
): Parsed<Locator> {
    const head = peekRecord(input, path, context.issues);
    if (head === INVALID) {
        return INVALID;
    }
    const by = readOneOf(head["by"], `${path}.by`, context.issues, ALL_LOCATOR_KINDS);
    if (by === INVALID) {
        return INVALID;
    }
    const byPath = `${path}.by`;
    if (
        isStructuralKind(by) &&
        !isFeatureEnabledElseRefused(LOCATOR_FEATURES[by], byPath, context)
    ) {
        return INVALID;
    }
    return LOCATOR_READERS[by](input, path, context, insideDepth);
}
