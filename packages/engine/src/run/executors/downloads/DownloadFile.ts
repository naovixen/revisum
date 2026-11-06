import {
    stepFailed,
    StepOutcome,
    type DownloadStep,
    type ResolvedDownloadStep,
} from "@revisum/contracts";
import { resolveLocator } from "../../../run-values.ts";
import { guardFor } from "../../GuardFor.ts";
import { keptText } from "../../Observe.ts";
import type { DownloadRecord } from "../../StepResult.ts";
import type { StepExecutor } from "../StepExecutor.ts";

// The driver clicks the element, asking the runtime guard first as for any click, and saves the one
// file the click starts, within the project's maximumDownloadBytes. The file is kept in memory under
// the plan's name for the checks after it; the result keeps only its name, media type, size and sha256.
export const downloadFile: StepExecutor<DownloadStep> = async (step, context) => {
    const locator = resolveLocator(step.locator, context.values, context.cleared.project);
    if (!locator.ok) {
        return stepFailed(locator.error);
    }
    const resolved: ResolvedDownloadStep = {
        type: step.type,
        name: step.name,
        locator: locator.value,
    };
    const saved = await context.document.download(
        resolved,
        context.cleared.project.limits.maximumDownloadBytes,
        guardFor(resolved, context.index, context),
    );
    if (!saved.ok) {
        return stepFailed(saved.error.code);
    }
    const file = saved.value;
    context.downloads.set(step.name, file);
    const record: DownloadRecord = {
        downloadName: step.name,
        fileName: keptText(file.fileName, context),
        mediaType: keptText(file.mediaType, context),
        size: file.bytes.length,
        sha256: file.sha256,
    };
    return { outcome: StepOutcome.Passed, download: record };
};
