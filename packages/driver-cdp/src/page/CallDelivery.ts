// How a page function is called and what comes back of it.
import type { CallArgument } from "../connection/BrowserCommand.ts";
import { CALL_FUNCTION_ON } from "../connection/domains/RuntimeDomain.ts";
import { MalformedBrowserReply } from "../connection/MalformedBrowserReply.ts";
import type { CallResult } from "../connection/RemoteObject.ts";
import type { PageArgument } from "./PageOperations.ts";

// How Runtime.callFunctionOn hands back what a page function returns.
export type CallDelivery = { readonly awaitPromise: true; readonly returnByValue: boolean };
export const AWAITED_VALUE: CallDelivery = { awaitPromise: true, returnByValue: true };
export const AWAITED_OBJECT: CallDelivery = { awaitPromise: true, returnByValue: false };

// What the page threw: the value thrown, when the browser gives it, or else the browser's text.
function thrownText(details: NonNullable<CallResult["exceptionDetails"]>): string {
    const thrown = details.exception?.value;
    switch (typeof thrown) {
        case "string":
            return thrown;
        case "number":
        case "boolean":
        case "bigint":
            return String(thrown);
        case "object":
            return thrown === null ? details.text : "[object Object]";
        case "undefined":
        case "function":
        case "symbol":
            return details.text;
    }
}

export function throwIfThePageThrew(called: CallResult): void {
    if (called.exceptionDetails !== undefined) {
        throw new Error(`page exception: ${thrownText(called.exceptionDetails)}`);
    }
}

export function textOfCall(called: CallResult): string {
    const text = called.result.value;
    if (typeof text !== "string") {
        throw new MalformedBrowserReply(CALL_FUNCTION_ON.method, "result.result.value");
    }
    return text;
}

export const callArgumentsOf = (inputs: readonly PageArgument<string>[]): CallArgument[] =>
    inputs.map((input) =>
        typeof input === "object" && "element" in input
            ? { objectId: input.element }
            : { value: input },
    );
