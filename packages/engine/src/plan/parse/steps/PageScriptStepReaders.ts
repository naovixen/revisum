// Page scripts, an unsafe feature: read only once the project enables it, which the step list
// checks before it reads a step.
import { CallEffect, PlanErrorCode, StepType } from "@revisum/contracts";
import { allValid, INVALID } from "../../plan-decoders.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { readBackendAssertion } from "../assertions/ReadBackendAssertion.ts";
import { readScriptArguments } from "../declarations/ReadCallArguments.ts";
import { readDeclaredField } from "../declarations/ReadDeclared.ts";
import { readRememberedFields } from "../declarations/ReadRememberedFields.ts";
import { readScriptChoice } from "../declarations/ReadScriptChoice.ts";
import { refuse } from "../Refuse.ts";
import { readCriterionId } from "../text/ReadCriterionId.ts";
import type { StepReaderTable } from "./StepReader.ts";

export const PAGE_SCRIPT_STEP_READERS: StepReaderTable<StepTypeIn<typeof StepSection.PageScripts>> =
    {
        // Runs its script, and may remember fields of its result once its arguments are read.
        evaluate(step, path, context) {
            const use = readScriptChoice(step["script"], `${path}.script`, context);
            if (use === INVALID) {
                return INVALID;
            }
            const { script, parameters } = use;
            const argumentsPath = `${path}.arguments`;
            const scriptArguments = readScriptArguments(
                step["arguments"],
                argumentsPath,
                parameters,
                context,
            );
            if (!Object.hasOwn(step, "remember")) {
                return scriptArguments === INVALID
                    ? INVALID
                    : { type: StepType.Evaluate, script, arguments: scriptArguments };
            }
            const remember = readRememberedFields(
                step["remember"],
                `${path}.remember`,
                use.fields,
                context,
            );
            return scriptArguments === INVALID || remember === INVALID
                ? INVALID
                : { type: StepType.Evaluate, script, arguments: scriptArguments, remember };
        },
        // A read script, one of its result fields and a check on it. A write script is refused as not
        // declared for this use, since a check may repeat its script.
        expectScript(step, path, context) {
            const use = readScriptChoice(step["script"], `${path}.script`, context);
            if (use === INVALID) {
                return INVALID;
            }
            if (use.effect !== CallEffect.Read) {
                return refuse(context.issues, PlanErrorCode.UnknownValue, use.effectPath);
            }
            const parts = [
                readScriptArguments(
                    step["arguments"],
                    `${path}.arguments`,
                    use.parameters,
                    context,
                ),
                readDeclaredField(step["field"], `${path}.field`, use.fields, context),
                readBackendAssertion(step["assert"], `${path}.assert`, context),
                readCriterionId(step, path, context),
            ] as const;
            if (!allValid(parts)) {
                return INVALID;
            }
            const [scriptArguments, field, assert, criterionId] = parts;
            return {
                type: StepType.ExpectScript,
                script: use.script,
                arguments: scriptArguments,
                field,
                assert,
                criterionId,
            };
        },
    };
