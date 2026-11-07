// Where a navigate step or a second tab goes: a URL, or a path template on the run's base URL.
import {
    isNonArrayObject,
    PlanErrorCode,
    type AllowedUrl,
    type PathTemplate,
    type SafeText,
    type TextOrValue,
} from "@revisum/contracts";
import { looksLikeCredential } from "../../literal-secrets.ts";
import {
    allValid,
    INVALID,
    peekRecord,
    readList,
    readRecord,
    type Parsed,
} from "../../plan-decoders.ts";
import { MAXIMUM_PATH_SEGMENTS, MAXIMUM_QUERY_VALUES, QUERY_KEY } from "../../plan-grammar.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readTextOrValue, readValueReference } from "./ReadTextOrValue.ts";
import { readUrl } from "./ReadUrl.ts";
import { readWrittenText } from "./ReadWrittenText.ts";

const SEGMENT_SEPARATOR = /[/?#]/;

// One literal segment of a path template. A separator would add segments or start a query or
// fragment; "." and ".." would climb the path. Both are refused here, before any run.
function readLiteralSegment(input: unknown, path: string, context: ParseContext): Parsed<SafeText> {
    const segment = readWrittenText(input, path, context, context.rules.limits.maximumTextLength);
    if (segment === INVALID) {
        return INVALID;
    }
    if (SEGMENT_SEPARATOR.test(segment)) {
        return refuse(context.issues, PlanErrorCode.UnknownValue, path);
    }
    if (segment === "." || segment === "..") {
        return refuse(context.issues, PlanErrorCode.InvalidUrl, path);
    }
    return segment;
}

const readSegment = (input: unknown, path: string, context: ParseContext): Parsed<TextOrValue> =>
    isNonArrayObject(input)
        ? readValueReference(input, path, context)
        : readLiteralSegment(input, path, context);

// One query value under its key. A malformed key is reported at the query itself, so the key is
// never echoed.
function readQueryEntry(
    key: string,
    value: unknown,
    queryPath: string,
    context: ParseContext,
): Parsed<readonly [string, TextOrValue]> {
    if (!QUERY_KEY.test(key)) {
        return refuse(context.issues, PlanErrorCode.UnknownValue, queryPath);
    }
    if (looksLikeCredential(key)) {
        return refuse(context.issues, PlanErrorCode.LiteralSecret, queryPath);
    }
    const longest = context.rules.limits.maximumTextLength;
    const text = readTextOrValue(value, `${queryPath}.${key}`, context, longest, 0);
    return text === INVALID ? INVALID : [key, text];
}

function readQuery(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<Readonly<Record<string, TextOrValue>>> {
    const query = peekRecord(input, path, context.issues);
    if (query === INVALID) {
        return INVALID;
    }
    if (Object.keys(query).length > MAXIMUM_QUERY_VALUES) {
        return refuse(context.issues, PlanErrorCode.TooLarge, path);
    }
    const entries = Object.entries(query).map(([key, value]) =>
        readQueryEntry(key, value, path, context),
    );
    return allValid(entries) ? Object.fromEntries(entries) : INVALID;
}

// A path template: segments and query values on the run's base URL. It has no origin field, so no
// value can choose where the browser goes. Segments that are not a list stop it there, before the
// query is read, which readFields would read anyway, so its fields are read by hand.
function readPathTemplate(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<PathTemplate> {
    const fields = readRecord(input, path, context.issues, ["segments", "query"], ["segments"]);
    if (fields === INVALID) {
        return INVALID;
    }
    const segmentsPath = `${path}.segments`;
    const written = readList(
        fields["segments"],
        segmentsPath,
        context.issues,
        MAXIMUM_PATH_SEGMENTS,
    );
    if (written === INVALID) {
        return INVALID;
    }
    const segments = written.map((segment, index) =>
        readSegment(segment, `${segmentsPath}[${index}]`, context),
    );
    if (!Object.hasOwn(fields, "query")) {
        return allValid(segments) ? { segments } : INVALID;
    }
    const query = readQuery(fields["query"], `${path}.query`, context);
    if (!allValid(segments) || query === INVALID) {
        return INVALID;
    }
    return { segments, query };
}

export function readNavigation(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<AllowedUrl | PathTemplate> {
    if (isNonArrayObject(input)) {
        return readPathTemplate(input, path, context);
    }
    return readUrl(input, path, context);
}
