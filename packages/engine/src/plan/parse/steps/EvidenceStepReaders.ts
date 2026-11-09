import { AUDIT_MODES, PlanErrorCode, StepType } from "@revisum/contracts";
import { brand } from "../../../foundation/Brand.ts";
import { looksLikeCredential } from "../../LooksLikeCredential.ts";
import { INVALID, readOneOf } from "../ReadRecord.ts";
import { CAPTURE_NAME } from "../../schema/PlanFields.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { refuse } from "../Refuse.ts";
import type { StepReaderTable } from "./StepReader.ts";

export const EVIDENCE_STEP_READERS: StepReaderTable<StepTypeIn<typeof StepSection.Evidence>> = {
    a11yAudit(step, path, context) {
        const mode = readOneOf(step.mode, `${path}.mode`, context.issues, AUDIT_MODES);
        return mode === INVALID ? INVALID : { type: StepType.A11yAudit, mode };
    },
    // A capture name names a file, so it follows the capture-name pattern.
    capture(step, path, context) {
        const name = step.name;
        const namePath = `${path}.name`;
        if (typeof name !== "string") {
            return refuse(context.issues, PlanErrorCode.WrongType, namePath);
        }
        if (!CAPTURE_NAME.test(name)) {
            return refuse(context.issues, PlanErrorCode.UnknownValue, namePath);
        }
        if (looksLikeCredential(name)) {
            return refuse(context.issues, PlanErrorCode.LiteralSecret, namePath);
        }
        return { type: StepType.Capture, name: brand<string, "CaptureName">(name) };
    },
};
