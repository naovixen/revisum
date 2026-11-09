import {
    DOWNLOAD_SIZE_KINDS,
    DownloadAssertionKind,
    DownloadSizeKind,
    PlanErrorCode,
    type DownloadAssertion,
} from "@revisum/contracts";
import type { ReadableInput } from "../../../decoding/ReadableCopy.ts";
import {
    INVALID,
    isOneOf,
    readInteger,
    readOneOf,
    type Issues,
    type Parsed,
} from "../ReadRecord.ts";
import { DOWNLOAD_KINDS, LARGEST_DOWNLOAD_BYTES } from "../../schema/PlanFields.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readExpectedText } from "../text/ReadTextOrValue.ts";
import { readWrittenText } from "../text/ReadWrittenText.ts";
import { readAssertionHead, readKindAndValue } from "./ReadAssertionHead.ts";

// A size in bytes. Every file is at least 0 bytes long, so a check that it is would prove nothing.
function readSize(
    input: ReadableInput,
    path: string,
    issues: Issues,
    kind: DownloadSizeKind,
): Parsed<number> {
    const size = readInteger(input, path, issues, 0, LARGEST_DOWNLOAD_BYTES);
    if (kind === DownloadSizeKind.SizeAtLeast && size === 0) {
        return refuse(issues, PlanErrorCode.Vacuous, path);
    }
    return size;
}

export function readDownloadAssertion(
    input: ReadableInput,
    path: string,
    context: ParseContext,
): Parsed<DownloadAssertion> {
    const head = readAssertionHead(input, path, context);
    if (head === INVALID) {
        return INVALID;
    }
    const kind = readOneOf(head["kind"], `${path}.kind`, context.issues, DOWNLOAD_KINDS);
    if (kind === INVALID) {
        return INVALID;
    }
    if (isOneOf(DOWNLOAD_SIZE_KINDS, kind)) {
        return readKindAndValue(input, path, context, kind, (value, valuePath, issues) =>
            readSize(value, valuePath, issues, kind),
        );
    }
    if (kind === DownloadAssertionKind.MediaTypeEquals) {
        const longest = context.rules.limits.maximumTextLength;
        return readKindAndValue(input, path, context, kind, (value, valuePath) =>
            readWrittenText(value, valuePath, context, longest),
        );
    }
    return readKindAndValue(input, path, context, kind, (value, valuePath) =>
        readExpectedText(value, valuePath, context),
    );
}
