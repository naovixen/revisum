// Calls to a declared service, and checks on a read call's response.
import { CallEffect, PlanErrorCode, StepType } from "@revisum/contracts";
import { allValid, INVALID } from "../../plan-decoders.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { readBackendAssertion } from "../assertions/ReadBackendAssertion.ts";
import { readCallArguments } from "../declarations/ReadCallArguments.ts";
import { readCallName, readDeclaredField } from "../declarations/ReadDeclared.ts";
import { readRememberedFields } from "../declarations/ReadRememberedFields.ts";
import { refuse } from "../Refuse.ts";
import { readCriterionId } from "../text/ReadCriterionId.ts";
import type { StepReaderTable } from "./StepReader.ts";

export const SERVICE_CALL_STEP_READERS: StepReaderTable<
    StepTypeIn<typeof StepSection.ServiceCalls>
> = {
    // Its remembered values are defined only once its arguments have been read, so it cannot use
    // them itself.
    call(step, path, context) {
        const named = readCallName(step.call, `${path}.call`, context);
        if (named === INVALID) {
            return INVALID;
        }
        const { name: call, declaration } = named;
        const argumentsPath = `${path}.arguments`;
        const parameters = declaration.parameters;
        const callArguments = readCallArguments(
            step.arguments,
            argumentsPath,
            parameters,
            context,
        );
        if (!Object.hasOwn(step, "remember")) {
            return callArguments === INVALID
                ? INVALID
                : { type: StepType.Call, call, arguments: callArguments };
        }
        const rememberPath = `${path}.remember`;
        const remember = readRememberedFields(
            step.remember,
            rememberPath,
            declaration.fields,
            context,
        );
        return callArguments === INVALID || remember === INVALID
            ? INVALID
            : { type: StepType.Call, call, arguments: callArguments, remember };
    },
    // A read call, one of its declared fields and a check on it. A write call is refused as if it
    // were not declared, since a check may repeat its call.
    expectBackend(step, path, context) {
        const callPath = `${path}.call`;
        const named = readCallName(step.call, callPath, context);
        if (named === INVALID) {
            return INVALID;
        }
        const { name: call, declaration } = named;
        if (declaration.effect !== CallEffect.Read) {
            return refuse(context.issues, PlanErrorCode.UnknownValue, callPath);
        }
        const parts = [
            readCallArguments(
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
        const [callArguments, field, assert, criterionId] = parts;
        return {
            type: StepType.ExpectBackend,
            call,
            arguments: callArguments,
            field,
            assert,
            criterionId,
        };
    },
};
