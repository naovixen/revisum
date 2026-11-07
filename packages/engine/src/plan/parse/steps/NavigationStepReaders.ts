import { SCRIPT_MODES, StepType } from "@revisum/contracts";
import { INVALID, readOneOf } from "../../plan-decoders.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { readNavigation } from "../text/ReadNavigation.ts";
import type { StepReaderTable } from "./StepReader.ts";

export const NAVIGATION_STEP_READERS: StepReaderTable<StepTypeIn<typeof StepSection.Navigation>> = {
    navigate(step, path, context) {
        const url = readNavigation(step["url"], `${path}.url`, context);
        // Left out when absent, so a navigate without it stays exactly as it was.
        if (!Object.hasOwn(step, "scripts")) {
            return url === INVALID ? INVALID : { type: StepType.Navigate, url };
        }
        const scriptsPath = `${path}.scripts`;
        const scripts = readOneOf(step["scripts"], scriptsPath, context.issues, SCRIPT_MODES);
        return url === INVALID || scripts === INVALID
            ? INVALID
            : { type: StepType.Navigate, url, scripts };
    },
};
