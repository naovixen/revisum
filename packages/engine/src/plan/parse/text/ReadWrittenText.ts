import { PlanErrorCode, type SafeText } from "@revisum/contracts";
import { looksLikeCredential } from "../../../decoding/LooksLikeCredential.ts";
import { INVALID, type Parsed } from "../../../decoding/ReadRecord.ts";
import { readUnscannedText } from "../../../decoding/ReadUnscannedText.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";

// Text the plan writes, refused as literal_secret when it is shaped like a credential.
export function readWrittenText(
    input: unknown,
    path: string,
    context: ParseContext,
    maximumLength: number,
    minimumLength = 1,
): Parsed<SafeText> {
    const text = readUnscannedText(input, path, context.issues, maximumLength, minimumLength);
    if (text !== INVALID && looksLikeCredential(text)) {
        return refuse(context.issues, PlanErrorCode.LiteralSecret, path);
    }
    return text;
}
