// Advances of the run's virtual clock, each a bounded whole amount of a unit and never a wait, and
// checks on the clipboard, which can only be checked or remembered, never written.
import {
    CLOCK_ADVANCE_MODES,
    CLOCK_UNITS,
    PlanErrorCode,
    StepType,
    type ClockAdvance,
} from "@revisum/contracts";
import { clockAdvanceMilliseconds } from "../../../clock-advance.ts";
import { allValid, INVALID, readOneOf, readRecord, type Parsed } from "../../plan-decoders.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { readClipboardAssertion } from "../assertions/ReadClipboardAssertion.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readCriterionId } from "../text/ReadCriterionId.ts";
import { readWhenPresent, type StepReaderTable } from "./StepReader.ts";

const isWholeAmount = (amount: unknown): amount is number =>
    typeof amount === "number" && Number.isInteger(amount) && amount >= 1;

// A whole amount of at least 1 of a unit, within the project's step limit. A missing amount is the
// wrong type, as any other non-whole amount is, so `amount` is read even when absent, which a field
// table would not do: it is read by hand. An amount too large for its unit is refused with
// too_large, never echoed.
function readClockAdvance(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<ClockAdvance> {
    const fields = readRecord(input, path, context.issues, ["amount", "unit"], ["unit"]);
    if (fields === INVALID) {
        return INVALID;
    }
    const amountPath = `${path}.amount`;
    const amount = fields["amount"];
    if (!isWholeAmount(amount)) {
        context.issues.push({ code: PlanErrorCode.WrongType, path: amountPath });
    }
    const unit = readOneOf(fields["unit"], `${path}.unit`, context.issues, CLOCK_UNITS);
    if (!isWholeAmount(amount) || unit === INVALID) {
        return INVALID;
    }
    const by = { amount, unit };
    if (clockAdvanceMilliseconds(by) > context.rules.limits.maximumClockAdvanceMilliseconds) {
        return refuse(context.issues, PlanErrorCode.TooLarge, amountPath);
    }
    return by;
}

// Adds an advance to the plan's total. Plans are straight-line, so the total is exactly how far
// the run's clock moves; the step at which it first passes the plan limit is refused, and only
// that one. False when this step is it.
function isWithinTotalAfterAdding(by: ClockAdvance, path: string, context: ParseContext): boolean {
    const total = context.clockAdvance;
    total.milliseconds += clockAdvanceMilliseconds(by);
    const limit = context.rules.limits.maximumTotalClockAdvanceMilliseconds;
    if (total.limitPassed || total.milliseconds <= limit) {
        return true;
    }
    total.limitPassed = true;
    context.issues.push({ code: PlanErrorCode.TooLarge, path });
    return false;
}

export const CLOCK_AND_CLIPBOARD_STEP_READERS: StepReaderTable<
    StepTypeIn<typeof StepSection.ClockAndClipboard>
> = {
    advanceClock(step, path, context) {
        const parts = [
            readClockAdvance(step.by, `${path}.by`, context),
            readWhenPresent(step, "mode", path, (mode, modePath) =>
                readOneOf(mode, modePath, context.issues, CLOCK_ADVANCE_MODES),
            ),
        ] as const;
        if (!allValid(parts) || !isWithinTotalAfterAdding(parts[0], path, context)) {
            return INVALID;
        }
        return { type: StepType.AdvanceClock, by: parts[0], mode: parts[1] };
    },
    expectClipboard(step, path, context) {
        const parts = [
            readClipboardAssertion(step.assert, `${path}.assert`, context),
            readCriterionId(step, path, context),
        ] as const;
        return allValid(parts)
            ? { type: StepType.ExpectClipboard, assert: parts[0], criterionId: parts[1] }
            : INVALID;
    },
};
