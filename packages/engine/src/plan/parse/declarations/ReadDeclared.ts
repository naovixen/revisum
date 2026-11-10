// Names a plan takes from the trusted project: a secret, a fixture or a test id attribute from a
// list, or a call, stub, observed request, storage entry, page script or database command with
// the declaration it names. An error never repeats the name.
import {
    PlanErrorCode,
    type Brand,
    type CallDeclaration,
    type CallName,
    type CommandName,
    type DatabaseCommandDeclaration,
    type FieldName,
    type JsonPointer,
    type ObservedRequestDeclaration,
    type PageScriptDeclaration,
    type RequestName,
    type ScriptName,
    type SecretReference,
    type StorageEntryDeclaration,
    type StorageEntryName,
    type StubDeclaration,
    type StubName,
} from "@revisum/contracts";
import { brand } from "../../../foundation/Brand.ts";
import { INVALID, type Parsed } from "../../../decoding/ReadRecord.ts";
import { readFields } from "../../ReadFields.ts";
import type { ParseContext } from "../ParseContext.ts";
import { refuse } from "../Refuse.ts";

// A name from a list the trusted project declares.
export function readDeclared<Name extends string>(
    input: unknown,
    path: string,
    context: ParseContext,
    declared: readonly Name[],
): Parsed<Name> {
    if (typeof input !== "string") {
        return refuse(context.issues, PlanErrorCode.WrongType, path);
    }
    const found = declared.find((name) => name === input);
    return found ?? refuse(context.issues, PlanErrorCode.UnknownValue, path);
}

// { "secretName": … }, naming a secret the project declares.
export function readSecretReference(
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<SecretReference> {
    const fields = readFields(input, path, context.issues, {
        secretName: (name, namePath) =>
            readDeclared(name, namePath, context, context.rules.secretNames),
    });
    return fields === INVALID ? INVALID : { secretName: fields.secretName };
}

// A declared name with the declaration it names.
export type Named<Name, Declaration> = { readonly name: Name; readonly declaration: Declaration };

// A name from one of the trusted project's sections of declarations, such as its calls or stubs,
// with the declaration it names. An undeclared name is refused alone: nothing else in the step is
// read against a declaration that does not exist.
function readDeclaredName<Kind extends string, Declaration>(
    input: unknown,
    path: string,
    context: ParseContext,
    section: Readonly<Record<Brand<string, Kind>, Declaration>>,
): Parsed<Named<Brand<string, Kind>, Declaration>> {
    if (typeof input !== "string") {
        return refuse(context.issues, PlanErrorCode.WrongType, path);
    }
    const found = Object.entries<Declaration>(section).find(([name]) => name === input);
    if (found === undefined) {
        return refuse(context.issues, PlanErrorCode.UnknownValue, path);
    }
    return { name: brand<string, Kind>(found[0]), declaration: found[1] };
}

export const readCallName = (
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<Named<CallName, CallDeclaration>> =>
    readDeclaredName<"CallName", CallDeclaration>(input, path, context, context.rules.calls);

export const readStubName = (
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<Named<StubName, StubDeclaration>> =>
    readDeclaredName<"StubName", StubDeclaration>(input, path, context, context.rules.stubs);

export const readRequestName = (
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<Named<RequestName, ObservedRequestDeclaration>> =>
    readDeclaredName<"RequestName", ObservedRequestDeclaration>(
        input,
        path,
        context,
        context.rules.observedRequests,
    );

export const readStorageEntryName = (
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<Named<StorageEntryName, StorageEntryDeclaration>> =>
    readDeclaredName<"StorageEntryName", StorageEntryDeclaration>(
        input,
        path,
        context,
        context.rules.storageEntries,
    );

export const readScriptName = (
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<Named<ScriptName, PageScriptDeclaration>> =>
    readDeclaredName<"ScriptName", PageScriptDeclaration>(
        input,
        path,
        context,
        context.rules.pageScripts,
    );

export const readCommandName = (
    input: unknown,
    path: string,
    context: ParseContext,
): Parsed<Named<CommandName, DatabaseCommandDeclaration>> =>
    readDeclaredName<"CommandName", DatabaseCommandDeclaration>(
        input,
        path,
        context,
        context.rules.databaseCommands,
    );

// A response field a call, an observed request, a script or a command declares, by its name.
export function readDeclaredField(
    input: unknown,
    path: string,
    fields: Readonly<Record<FieldName, JsonPointer>> | undefined,
    context: ParseContext,
): Parsed<FieldName> {
    if (typeof input !== "string") {
        return refuse(context.issues, PlanErrorCode.WrongType, path);
    }
    if (!Object.hasOwn(fields ?? {}, input)) {
        return refuse(context.issues, PlanErrorCode.UnknownValue, path);
    }
    return brand<string, "FieldName">(input);
}
