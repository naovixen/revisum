// Steps that name a stub, an observed request or a storage entry the trusted project declares, and
// give typed arguments: never a response, a matcher, a storage key or a value to store.
import {
    PlanErrorCode,
    StepType,
    StorageAccess,
    StubAction,
    STUB_ACTIONS,
    type StorageEntryDeclaration,
    type StorageEntryName,
} from "@revisum/contracts";
import { allValid, INVALID, readOneOf, type Parsed } from "../../plan-decoders.ts";
import type { StepSection, StepTypeIn } from "../../StepFacts.ts";
import { readRequestCount } from "../assertions/ReadRequestCount.ts";
import { readResponseAssertion } from "../assertions/ReadResponseAssertion.ts";
import { readStorageAssertion } from "../assertions/ReadStorageAssertion.ts";
import { readOptionalArguments } from "../declarations/ReadCallArguments.ts";
import {
    readRequestName,
    readStorageEntryName,
    readStubName,
    type Named,
} from "../declarations/ReadDeclared.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";
import { readCriterionId } from "../text/ReadCriterionId.ts";
import type { StepReaderTable } from "./StepReader.ts";

// A storage entry a step may write or remove: one the project declares readWrite. An entry declared
// read may only be checked, so writing it is refused as a name the plan may not use there.
function readWritableEntry(
    step: { readonly entry?: unknown },
    path: string,
    context: ParseContext,
): Parsed<Named<StorageEntryName, StorageEntryDeclaration>> {
    const entryPath = `${path}.entry`;
    const named = readStorageEntryName(step.entry, entryPath, context);
    if (named !== INVALID && named.declaration.access !== StorageAccess.ReadWrite) {
        return refuse(context.issues, PlanErrorCode.UnknownValue, entryPath);
    }
    return named;
}

export const NETWORK_AND_STORAGE_STEP_READERS: StepReaderTable<
    StepTypeIn<typeof StepSection.NetworkAndStorage>
> = {
    // A start, with arguments for the stub's parameters, or a stop, with none. A stop names a stub
    // an earlier step started, so a plan cannot stop what it never faked.
    stub(step, path, context) {
        const stubPath = `${path}.stub`;
        const named = readStubName(step.stub, stubPath, context);
        const action = readOneOf(step.action, `${path}.action`, context.issues, STUB_ACTIONS);
        if (named === INVALID || action === INVALID) {
            return INVALID;
        }
        const { name: stub, declaration } = named;
        if (action === StubAction.Stop) {
            if (Object.hasOwn(step, "arguments")) {
                return refuse(context.issues, PlanErrorCode.UnknownField, `${path}.arguments`);
            }
            if (!context.startedStubs.has(stub)) {
                return refuse(context.issues, PlanErrorCode.UnknownValue, stubPath);
            }
            return { type: StepType.Stub, stub, action };
        }
        context.startedStubs.add(stub);
        const stubArguments = readOptionalArguments(step, path, declaration.parameters, context);
        return stubArguments === INVALID
            ? INVALID
            : { type: StepType.Stub, stub, action, ...stubArguments };
    },
    resetRequests(step, path, context) {
        const named = readRequestName(step.request, `${path}.request`, context);
        return named === INVALID ? INVALID : { type: StepType.ResetRequests, request: named.name };
    },
    expectRequests(step, path, context) {
        const named = readRequestName(step.request, `${path}.request`, context);
        if (named === INVALID) {
            return INVALID;
        }
        const parts = [
            readRequestCount(step.count, `${path}.count`, context),
            readCriterionId(step, path, context),
        ] as const;
        return allValid(parts)
            ? {
                  type: StepType.ExpectRequests,
                  request: named.name,
                  count: parts[0],
                  criterionId: parts[1],
              }
            : INVALID;
    },
    expectResponse(step, path, context) {
        const named = readRequestName(step.request, `${path}.request`, context);
        if (named === INVALID) {
            return INVALID;
        }
        const parts = [
            readResponseAssertion(step.assert, `${path}.assert`, named.declaration, context),
            readCriterionId(step, path, context),
        ] as const;
        return allValid(parts)
            ? {
                  type: StepType.ExpectResponse,
                  request: named.name,
                  assert: parts[0],
                  criterionId: parts[1],
              }
            : INVALID;
    },
    setStorage(step, path, context) {
        const named = readWritableEntry(step, path, context);
        if (named === INVALID) {
            return INVALID;
        }
        const parameters = named.declaration.parameters ?? {};
        const entryArguments = readOptionalArguments(step, path, parameters, context);
        return entryArguments === INVALID
            ? INVALID
            : { type: StepType.SetStorage, entry: named.name, ...entryArguments };
    },
    removeStorage(step, path, context) {
        const named = readWritableEntry(step, path, context);
        return named === INVALID ? INVALID : { type: StepType.RemoveStorage, entry: named.name };
    },
    expectStorage(step, path, context) {
        const named = readStorageEntryName(step.entry, `${path}.entry`, context);
        if (named === INVALID) {
            return INVALID;
        }
        const parts = [
            readStorageAssertion(step.assert, `${path}.assert`, context),
            readCriterionId(step, path, context),
        ] as const;
        return allValid(parts)
            ? {
                  type: StepType.ExpectStorage,
                  entry: named.name,
                  assert: parts[0],
                  criterionId: parts[1],
              }
            : INVALID;
    },
};
