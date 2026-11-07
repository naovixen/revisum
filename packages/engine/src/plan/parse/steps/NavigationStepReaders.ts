import { SCRIPT_MODES, StepType } from "@revisum/contracts";
import { allValid, INVALID, readOneOf } from "../../plan-decoders.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { readNavigation } from "../text/ReadNavigation.ts";
import { readWhenPresent, type StepReaderTable } from "./StepReader.ts";

export const NAVIGATION_STEP_READERS: StepReaderTable<StepTypeIn<typeof StepSection.Navigation>> = {
    navigate(step, path, context) {
        const parts = [
            readNavigation(step.url, `${path}.url`, context),
            readWhenPresent(step, "scripts", path, (scripts, scriptsPath) =>
                readOneOf(scripts, scriptsPath, context.issues, SCRIPT_MODES),
            ),
        ] as const;
        return allValid(parts)
            ? { type: StepType.Navigate, url: parts[0], scripts: parts[1] }
            : INVALID;
    },
};
