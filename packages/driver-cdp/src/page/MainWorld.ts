// One document as the page's own main world sees it, where the page's scripts run and can answer
// whatever they like, so nothing read here is evidence of what is on the page.
import type { CallArgument } from "../connection/BrowserCommand.ts";
import {
    CALL_FUNCTION_ON,
    EVALUATE,
    RELEASE_OBJECT,
    RELEASE_OBJECT_GROUP,
} from "../connection/domains/RuntimeDomain.ts";
import { DESCRIBE_NODE, RESOLVE_NODE } from "../connection/domains/DomDomain.ts";
import { GET_EVENT_LISTENERS } from "../connection/domains/DomDebuggerDomain.ts";
import type { RemoteObject } from "../connection/RemoteObject.ts";
import { isNotDisabledByItsProperty } from "../in-page/elements/EnabledState.ts";
import { scriptResultText } from "../in-page/document/ScriptResultText.ts";
import { windowOfTheDocument } from "../in-page/document/WindowOfTheDocument.ts";
import { AWAITED_VALUE, callArgumentsOf, textOfCall, throwIfThePageThrew } from "./CallDelivery.ts";
import type { PageCommands } from "./PageCommands.ts";
import type { PageFunction } from "./PageFunction.ts";
import type { HasStepEnded, PageArgument, ScriptCallOutcome } from "./PageOperations.ts";

// The remote objects a call in the main world makes, released together once it has what it needs.
const SCRIPT_OBJECT_GROUP = "driver-page-script";
// The events a pointer's press sends on its way, or sets off when it moves the focus.
const PRESS_EVENT = /^(?:pointer|mouse|click|auxclick|dblclick|touch|focus|blur|contextmenu)/;

// A remote value passed back to the page as a call argument: by reference, as a value JSON cannot
// carry (NaN, a bigint), or as undefined, which an empty argument stands for.
function callArgumentOf(remote: RemoteObject): CallArgument {
    if (remote.objectId !== undefined) {
        return { objectId: remote.objectId };
    }
    if (remote.unserializableValue !== undefined) {
        return { unserializableValue: remote.unserializableValue };
    }
    return remote.type === "undefined" ? {} : { value: remote.value };
}

// Decodes what scriptResultText gives. Anything of another shape, such as from a page that replaced
// JSON.stringify, is a result JSON cannot write.
function decodeScriptResult(value: unknown): ScriptCallOutcome {
    if (
        Array.isArray(value) &&
        value.length === 2 &&
        value[0] === "text" &&
        typeof value[1] === "string"
    ) {
        return { kind: "result", text: value[1] };
    }
    return { kind: "not-json" };
}

export class MainWorld {
    readonly #commands: PageCommands;
    // The iframe element whose document this is, in its parent document; null for the top document.
    readonly #frameElement: string | null;

    constructor(commands: PageCommands, frameElement: string | null) {
        this.#commands = commands;
        this.#frameElement = frameElement;
    }

    async callForString(
        pageFunction: PageFunction,
        inputs: readonly PageArgument<string>[],
    ): Promise<string> {
        const called = await this.#commands.ask(CALL_FUNCTION_ON, {
            functionDeclaration: pageFunction.toString(),
            objectId: await this.#document(),
            arguments: callArgumentsOf(inputs),
            ...AWAITED_VALUE,
        });
        throwIfThePageThrew(called);
        return textOfCall(called);
    }

    // True when one of the nodes, or the document's window, has a listener for a pointer's events.
    async hasPressListener(nodes: readonly string[]): Promise<boolean> {
        try {
            for (const node of nodes) {
                if (await this.#hasPressListenerOn(await this.#inMainWorld(node))) {
                    return true;
                }
            }
            return await this.#hasPressListenerOn(await this.#window());
        } finally {
            await this.#commands.releaseKept(RELEASE_OBJECT_GROUP, {
                objectGroup: SCRIPT_OBJECT_GROUP,
            });
        }
    }

    // The read is all the page's code gets to run in, and a boolean is all that can come out of it.
    // The release is not waited for, as for a check: a page that has started to navigate answers nothing.
    async isCustomElementEnabled(element: string): Promise<boolean> {
        const inMainWorld = await this.#inMainWorld(element);
        try {
            const called = await this.#commands.ask(CALL_FUNCTION_ON, {
                functionDeclaration: isNotDisabledByItsProperty.toString(),
                objectId: inMainWorld,
                returnByValue: true,
            });
            return called.exceptionDetails === undefined && called.result.value === true;
        } finally {
            void this.#commands.releaseKept(RELEASE_OBJECT, { objectId: inMainWorld });
        }
    }

    // The source is compiled by the browser as the function it declares and called once with the
    // arguments object, never spliced into other text; then its result is written as JSON in the
    // page. Writing the result runs in the page's main world too, where a result's own toJSON is the
    // page's code, so it also goes only while the step lasts.
    async callScript(
        source: string,
        scriptArguments: Readonly<Record<string, string | number | boolean>>,
        maximumResultBytes: number,
        hasStepEnded: HasStepEnded,
    ): Promise<ScriptCallOutcome> {
        try {
            const objectId = await this.#document();
            const called = await this.#commands.askAsInput(
                CALL_FUNCTION_ON,
                {
                    functionDeclaration: source,
                    objectId,
                    arguments: [{ value: scriptArguments }],
                    awaitPromise: true,
                    returnByValue: false,
                    objectGroup: SCRIPT_OBJECT_GROUP,
                },
                hasStepEnded,
            );
            if (called.exceptionDetails !== undefined) {
                return { kind: "threw" };
            }
            const written = await this.#commands.askAsInput(
                CALL_FUNCTION_ON,
                {
                    functionDeclaration: scriptResultText.toString(),
                    objectId,
                    arguments: [callArgumentOf(called.result), { value: maximumResultBytes }],
                    returnByValue: true,
                    objectGroup: SCRIPT_OBJECT_GROUP,
                },
                hasStepEnded,
            );
            return written.exceptionDetails === undefined
                ? decodeScriptResult(written.result.value)
                : { kind: "not-json" };
        } finally {
            await this.#commands.releaseKept(RELEASE_OBJECT_GROUP, {
                objectGroup: SCRIPT_OBJECT_GROUP,
            });
        }
    }

    // The browser reports only the listeners of the script world the object is read through, and a
    // page's own are in its main world.
    async #inMainWorld(node: string): Promise<string> {
        const described = await this.#commands.ask(DESCRIBE_NODE, { objectId: node });
        const resolved = await this.#commands.ask(RESOLVE_NODE, {
            backendNodeId: described.node.backendNodeId,
            objectGroup: SCRIPT_OBJECT_GROUP,
        });
        return resolved.object.objectId;
    }

    async #window(): Promise<string> {
        const found = await this.#commands.ask(CALL_FUNCTION_ON, {
            functionDeclaration: windowOfTheDocument.toString(),
            objectId: await this.#document(),
            objectGroup: SCRIPT_OBJECT_GROUP,
        });
        if (found.result.objectId === undefined) {
            throw new Error("the document has no window");
        }
        return found.result.objectId;
    }

    async #hasPressListenerOn(objectId: string): Promise<boolean> {
        const { listeners } = await this.#commands.ask(GET_EVENT_LISTENERS, { objectId });
        return listeners.some((listener) => PRESS_EVENT.test(listener.type));
    }

    // This document's object in the main world: the top document's default world, or the main world
    // of the iframe's document, which the browser resolves a node in when given no world.
    async #document(): Promise<string> {
        if (this.#frameElement === null) {
            const evaluated = await this.#commands.ask(EVALUATE, {
                expression: "document",
                objectGroup: SCRIPT_OBJECT_GROUP,
            });
            if (evaluated.result.objectId === undefined) {
                throw new Error("no document");
            }
            return evaluated.result.objectId;
        }
        const described = await this.#commands.ask(DESCRIBE_NODE, { objectId: this.#frameElement });
        const backendNodeId = described.node.contentDocument?.backendNodeId;
        if (backendNodeId === undefined) {
            throw new Error("the frame has no document");
        }
        const resolved = await this.#commands.ask(RESOLVE_NODE, {
            backendNodeId,
            objectGroup: SCRIPT_OBJECT_GROUP,
        });
        return resolved.object.objectId;
    }
}
