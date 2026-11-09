// Database commands, an unsafe feature: read only once the project enables it, which the step list
// checks before it reads a step.
import { CallEffect, PlanErrorCode, StepType } from "@revisum/contracts";
import { allValid, INVALID } from "../ReadRecord.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { readBackendAssertion } from "../assertions/ReadBackendAssertion.ts";
import { readScriptArguments } from "../declarations/ReadCallArguments.ts";
import { readCommandName, readDeclaredField } from "../declarations/ReadDeclared.ts";
import { readRememberedFields } from "../declarations/ReadRememberedFields.ts";
import { refuse } from "../Refuse.ts";
import { readCriterionId } from "../text/ReadCriterionId.ts";
import { readWhenPresent, type StepReaderTable } from "./StepReader.ts";

export const DATABASE_COMMAND_STEP_READERS: StepReaderTable<
    StepTypeIn<typeof StepSection.DatabaseCommands>
> = {
    // Runs a declared command, and may remember fields of its JSON output.
    database(step, path, context) {
        const named = readCommandName(step.command, `${path}.command`, context);
        if (named === INVALID) {
            return INVALID;
        }
        const { name: command, declaration } = named;
        const commandArguments = readScriptArguments(
            step.arguments,
            `${path}.arguments`,
            declaration.parameters,
            context,
        );
        const remember = readWhenPresent(step, "remember", path, (fields, rememberPath) =>
            readRememberedFields(fields, rememberPath, declaration.fields, context),
        );
        return commandArguments === INVALID || remember === INVALID
            ? INVALID
            : { type: StepType.Database, command, arguments: commandArguments, remember };
    },
    // A read command, one of its output fields and a check on it. A write command is refused as
    // not declared for this use, since a check may repeat its command.
    expectDatabase(step, path, context) {
        const commandPath = `${path}.command`;
        const named = readCommandName(step.command, commandPath, context);
        if (named === INVALID) {
            return INVALID;
        }
        const { name: command, declaration } = named;
        if (declaration.effect !== CallEffect.Read) {
            return refuse(context.issues, PlanErrorCode.UnknownValue, commandPath);
        }
        const parts = [
            readScriptArguments(
                step.arguments,
                `${path}.arguments`,
                declaration.parameters,
                context,
            ),
            readDeclaredField(step.field, `${path}.field`, declaration.fields, context),
            readBackendAssertion(step.assert, `${path}.assert`, context),
            readCriterionId(step, path, context),
        ] as const;
        if (!allValid(parts)) {
            return INVALID;
        }
        const [commandArguments, field, assert, criterionId] = parts;
        return {
            type: StepType.ExpectDatabase,
            command,
            arguments: commandArguments,
            field,
            assert,
            criterionId,
        };
    },
};
