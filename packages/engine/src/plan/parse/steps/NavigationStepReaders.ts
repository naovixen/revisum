import { SCRIPT_MODES, StepType } from "@revisum/contracts";
import { readOneOf } from "../../plan-decoders.ts";
import { optionalField, readFields } from "../../ReadFields.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { knownField } from "../KnownField.ts";
import { readNavigation } from "../text/ReadNavigation.ts";
import type { StepReaderTable } from "./StepReader.ts";

export const NAVIGATION_STEP_READERS: StepReaderTable<StepTypeIn<typeof StepSection.Navigation>> = {
    navigate(step, path, context) {
        return readFields(step, path, context.issues, {
            type: knownField(StepType.Navigate),
            url: (url: unknown, urlPath: string) => readNavigation(url, urlPath, context),
            // Left out when absent, so a navigate without it stays exactly as it was.
            scripts: optionalField((scripts: unknown, scriptsPath: string) =>
                readOneOf(scripts, scriptsPath, context.issues, SCRIPT_MODES),
            ),
        });
    },
};
