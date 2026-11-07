// Checks on an element or the page, and remember steps, which read a value for the steps after them.
import { ElementAssertionKind, PlanErrorCode, StepType } from "@revisum/contracts";
import { allValid, INVALID } from "../../plan-decoders.ts";
import { FROM_FIELD } from "../../plan-grammar.ts";
import { readValueName } from "../../plan-values.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { readElementAssertion } from "../assertions/ReadElementAssertion.ts";
import { readPageAssertion } from "../assertions/ReadPageAssertion.ts";
import { isNameTaken } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readCriterionId } from "../text/ReadCriterionId.ts";
import { readRememberSource } from "./ReadRememberSource.ts";
import { readStepLocator, type StepReaderTable } from "./StepReader.ts";

// Checks that count matches, which a position picking one of them would make meaningless.
const COUNTING_KINDS: readonly string[] = [
    ElementAssertionKind.CountEquals,
    ElementAssertionKind.Absent,
];

export const PAGE_CHECK_STEP_READERS: StepReaderTable<StepTypeIn<typeof StepSection.PageChecks>> = {
    expect(step, path, context) {
        const parts = [
            readStepLocator(step, path, context),
            readElementAssertion(step.assert, `${path}.assert`, context),
            readCriterionId(step, path, context),
        ] as const;
        if (!allValid(parts)) {
            return INVALID;
        }
        const [locator, assert, criterionId] = parts;
        if (COUNTING_KINDS.includes(assert.kind) && locator.position !== undefined) {
            const positionPath = `${path}.locator.position`;
            return refuse(context.issues, PlanErrorCode.PositionNotAllowed, positionPath);
        }
        return { type: StepType.Expect, locator, assert, criterionId };
    },
    expectPage(step, path, context) {
        const parts = [
            readPageAssertion(step.assert, `${path}.assert`, context),
            readCriterionId(step, path, context),
        ] as const;
        return allValid(parts)
            ? { type: StepType.ExpectPage, assert: parts[0], criterionId: parts[1] }
            : INVALID;
    },
    // A remember step defines its name only once it has been read, so its own locator cannot use
    // it, and a name already defined is a duplicate.
    remember(step, path, context) {
        const namePath = `${path}.name`;
        const name = readValueName(step.name, namePath, context.issues);
        const from = readRememberSource(step[FROM_FIELD], `${path}.${FROM_FIELD}`, context);
        if (name === INVALID) {
            return INVALID;
        }
        if (isNameTaken(name, context)) {
            return refuse(context.issues, PlanErrorCode.Duplicate, namePath);
        }
        context.defined.add(name);
        return from === INVALID ? INVALID : { type: StepType.Remember, name, from };
    },
};
