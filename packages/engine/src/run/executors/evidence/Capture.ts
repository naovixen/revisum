import {
    StepCode,
    StepOutcome,
    stepFailed,
    type DocumentSession,
    type DriverError,
    type Result,
    type StepByType,
} from "@revisum/contracts";
import { codeOfFailedCapture } from "../../CodeForThrow.ts";
import type { RunContext } from "../../RunContext.ts";
import type { StepExecutor } from "../StepExecutor.ts";

// The viewport with personal data and every field a secret was typed into masked. Not-found says one of
// those fields cannot be masked: text drawn as pixels is out of reach of any later scan, so no image is
// better than an image that may show the secret. Any other failure says the page could not be captured.
async function pixelsWithSecretsHidden(
    document: DocumentSession,
    context: RunContext,
): Promise<Result<Uint8Array, DriverError>> {
    const selectors = context.ports.redactor.selectors;
    const fields = [...context.secretFilledFields.values()];
    if (fields.length === 0) {
        return document.screenshot(selectors);
    }
    return document.screenshotHidingFields(selectors, fields, context.holdsSecret);
}

// Keeps a screenshot of the page as an artifact, under the target's id and the capture's name.
export const capture: StepExecutor<StepByType["capture"]> = async (step, context) => {
    const taken = await pixelsWithSecretsHidden(context.document, context);
    if (!taken.ok) {
        return taken.error.code === StepCode.NotFound
            ? { outcome: StepOutcome.Passed, code: StepCode.CaptureLeftOut }
            : stepFailed(codeOfFailedCapture(taken.error, context.logger));
    }
    const reference = await context.ports.artifacts.put(
        `${context.cleared.target.id}/${step.name}.png`,
        taken.value,
        "image/png",
    );
    context.logger.log({
        kind: "artifact",
        stepIndex: context.index,
        artifact: reference.name,
        sha256: reference.sha256,
    });
    return { outcome: StepOutcome.Passed, artifact: reference };
};
