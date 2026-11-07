import {
    literalText,
    PlanErrorCode,
    type MultiLineText,
    type TextOrValue,
} from "@revisum/contracts";
import { allValid, INVALID, readList, type Issues, type Parsed } from "../../plan-decoders.ts";
import { readFields } from "../../ReadFields.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readTextOrValue } from "./ReadTextOrValue.ts";

// The path of the line at which the lines first hold more than `maximumCharacters`, counting the
// line feed between lines, or undefined. A value reference counts as no characters here: its text
// is only known at run time.
function lineCrossingLimit(
    lines: readonly TextOrValue[],
    linesPath: string,
    maximumCharacters: number,
): string | undefined {
    let characters = 0;
    for (const [index, line] of lines.entries()) {
        const separator = index === 0 ? 0 : 1;
        characters += separator + (literalText(line)?.length ?? 0);
        if (characters > maximumCharacters) {
            return `${linesPath}[${index}]`;
        }
    }
    return undefined;
}

function readLines(
    input: unknown,
    linesPath: string,
    issues: Issues,
    context: ParseContext,
): Parsed<readonly TextOrValue[]> {
    const { maximumFillLines, maximumFillCharacters } = context.rules.limits;
    const written = readList(input, linesPath, issues, Number.POSITIVE_INFINITY);
    if (written === INVALID) {
        return INVALID;
    }
    if (written.length > maximumFillLines) {
        return refuse(issues, PlanErrorCode.TooLarge, `${linesPath}[${maximumFillLines}]`);
    }
    const lines = written.map((line, index) =>
        readTextOrValue(line, `${linesPath}[${index}]`, context, maximumFillCharacters, 0),
    );
    if (!allValid(lines)) {
        return INVALID;
    }
    const crossing = lineCrossingLimit(lines, linesPath, maximumFillCharacters);
    return crossing === undefined ? lines : refuse(issues, PlanErrorCode.TooLong, crossing);
}

// Lines for a multi-line fill, within the project's limits. Too many lines are reported at the
// first line past the limit; too many characters at the line that crosses the limit.
export function readMultiLineText(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<MultiLineText> {
    const fields = readFields(input, path, context.issues, {
        lines: (lines, linesPath, issues) => readLines(lines, linesPath, issues, context),
    });
    return fields === INVALID ? INVALID : { lines: fields.lines };
}
