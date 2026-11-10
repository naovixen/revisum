import { PlanErrorCode, StepType, type DownloadName } from "@revisum/contracts";
import { brand } from "../../../foundation/Brand.ts";
import { looksLikeCredential } from "../../../decoding/LooksLikeCredential.ts";
import { allValid, INVALID, type Parsed } from "../../../decoding/ReadRecord.ts";
import { DOWNLOAD_NAME } from "../../../decoding/PlanFields.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { readDownloadAssertion } from "../assertions/ReadDownloadAssertion.ts";
import { isNameTaken, type ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readCriterionId } from "../text/ReadCriterionId.ts";
import { readStepLocator, type StepReaderTable } from "./StepReader.ts";

// A download's name as plain text, never a value reference: it names the file for the plan, not
// for the page. The error never repeats the name.
function readDownloadName(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<DownloadName> {
    if (typeof input !== "string") {
        return refuse(context.issues, PlanErrorCode.WrongType, path);
    }
    if (!DOWNLOAD_NAME.test(input)) {
        return refuse(context.issues, PlanErrorCode.UnknownValue, path);
    }
    if (looksLikeCredential(input)) {
        return refuse(context.issues, PlanErrorCode.LiteralSecret, path);
    }
    return brand<string, "DownloadName">(input);
}

// The download an expectDownload checks: one an earlier download step defined.
function readDownloadReference(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<DownloadName> {
    const name = readDownloadName(input, path, context);
    if (name !== INVALID && !context.downloads.has(name)) {
        return refuse(context.issues, PlanErrorCode.UndefinedValue, path);
    }
    return name;
}

export const DOWNLOAD_STEP_READERS: StepReaderTable<StepTypeIn<typeof StepSection.Downloads>> = {
    // A download step defines its name once its locator has been read; a name a run value or
    // another download already has is a duplicate. The name stays defined for every step after it,
    // also after the frame or second tab it was defined in.
    download(step, path, context) {
        const locator = readStepLocator(step, path, context);
        const namePath = `${path}.name`;
        const name = readDownloadName(step.name, namePath, context);
        if (name === INVALID) {
            return INVALID;
        }
        if (isNameTaken(name, context)) {
            return refuse(context.issues, PlanErrorCode.Duplicate, namePath);
        }
        context.downloads.add(name);
        return locator === INVALID ? INVALID : { type: StepType.Download, name, locator };
    },
    expectDownload(step, path, context) {
        const parts = [
            readDownloadReference(step.download, `${path}.download`, context),
            readDownloadAssertion(step.assert, `${path}.assert`, context),
            readCriterionId(step, path, context),
        ] as const;
        return allValid(parts)
            ? {
                  type: StepType.ExpectDownload,
                  download: parts[0],
                  assert: parts[1],
                  criterionId: parts[2],
              }
            : INVALID;
    },
};
