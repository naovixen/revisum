import {
    stepFailed,
    StepOutcome,
    type DownloadStep,
    type ResolvedDownloadStep,
    type DownloadRecord,
} from "@revisum/contracts";
import { resolveLocator } from "../../../run-values.ts";
import { actGuarded } from "../../ActGuarded.ts";
import { keptText } from "../../Observe.ts";
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
    const saved = await actGuarded(resolved, context.index, context, (guard) =>
        context.document.download(
            resolved,
            context.cleared.project.limits.maximumDownloadBytes,
            guard,
        ),
    );
    if (!saved.ok) {
        return saved.error;
    }
    if (!saved.value.ok) {
        return stepFailed(saved.value.error.code);
    }
    const file = saved.value.value;
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
