// Records a refusal and gives INVALID, so a decoder refuses in one statement.
import type { PlanErrorCode } from "@revisum/contracts";
import { INVALID, type Issues } from "../../decoding/ReadRecord.ts";

export const refuse = (issues: Issues, code: PlanErrorCode, path: string): typeof INVALID => {
    issues.push({ code, path });
    return INVALID;
};
