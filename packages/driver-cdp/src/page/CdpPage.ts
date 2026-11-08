// PageOperations over one flat CDP session, for its top document or one of its iframes' documents.
// Element handles are remote object ids. Reads go through the driver's own reading world; what the
// main world, the click checks and input do is each in a part of its own.
import type { A11yNode, Key } from "@revisum/contracts";
import {
    CAPTURE_SCREENSHOT,
    GET_FRAME_TREE,
    NAVIGATE,
    SET_SCRIPT_EXECUTION_DISABLED,
} from "../connection/BrowserCommand.ts";
import { CALL_FUNCTION_ON, EVALUATE, GET_PROPERTIES } from "../connection/RuntimeDomain.ts";
import { DESCRIBE_NODE, RESOLVE_NODE } from "../connection/DomDomain.ts";
import { QUERY_ACCESSIBILITY_TREE } from "../connection/AccessibilityDomain.ts";
import type { CdpConnection } from "../connection/CdpConnection.ts";
import { MalformedBrowserReply } from "../connection/MalformedBrowserReply.ts";
import type { CallResult, FrameTree } from "../connection/RemoteObject.ts";
import { frameContentOffset } from "../in-page/Actionability.ts";
import { afterTwoFrames } from "../in-page/AfterTwoFrames.ts";
import { nodesAPressPasses, pressActsByItself } from "../in-page/NodesAPressPasses.ts";
import { isConnectedToItsDocument } from "../in-page/ProbeElement.ts";
import {
    AWAITED_OBJECT,
    AWAITED_VALUE,
    callArgumentsOf,
    textOfCall,
    throwIfThePageThrew,
    type CallDelivery,
} from "./CallDelivery.ts";
import { CdpPageInput } from "./CdpPageInput.ts";
import { ClickCheckWorld } from "./ClickCheckWorld.ts";
import { decodePoint } from "./DecodePoint.ts";
import type { HeldModifierKey } from "./HeldModifierKeys.ts";
import { isDocumentGone, isFrameOutOfReach, isLostObject } from "./LostObject.ts";
import { MainWorld } from "./MainWorld.ts";
import { PageCommands } from "./PageCommands.ts";
import type { PageFunction } from "./PageFunction.ts";
import { PageHeldByDialog } from "./PageHeldByDialog.ts";
import type {
    ExposedStates,
    HasStepEnded,
    PageArgument,
    PageWithInput,
    Point,
    RoleAndName,
    ScriptCallOutcome,
    SelectOutcome,
} from "./PageOperations.ts";
import type { PageWatch } from "./PageWatch.ts";
import type { PressCheck, PressSent } from "./PressCheck.ts";
import { accessibilityTreeOf, exposedStatesOf, roleAndNameOf } from "./RoleAndNameOf.ts";
import { WhenLoaded, type LoadWait } from "./WhenLoaded.ts";

// Where a CdpPage's document is when it is an iframe's: its element in the parent document, and its frame.
type FrameScope = {
    readonly parent: CdpPage;
    readonly frameElement: string;
    readonly frameId: string;
};

// What Page.navigate reports for a response whose HTTP status is an error and whose body is empty.
const HTTP_ERROR_STATUS = "net::ERR_HTTP_RESPONSE_CODE_FAILURE";

export class CdpPage implements PageWithInput<string> {
    readonly #commands: PageCommands;
    readonly #frame: FrameScope | null;
    readonly #mainWorld: MainWorld;
    readonly #clickChecks: ClickCheckWorld;
    readonly #input: CdpPageInput;
    readonly #whenLoaded: WhenLoaded;
    // For the top document: whether the page's scripts are off, and its frame's id once known. A
    // page's top frame keeps its id for as long as the tab lives.
    #scriptsDisabled = false;
    #topFrameId: string | null = null;

    // The top document of the page the watch is of.
    static topDocument(connection: CdpConnection, sessionId: string, watch: PageWatch): CdpPage {
        return new CdpPage(new PageCommands(connection, sessionId, watch), null);
    }

    // Made by topDocument, and by frame for a document inside this one.
    constructor(commands: PageCommands, frame: FrameScope | null) {
        this.#commands = commands;
        this.#frame = frame;
        this.#mainWorld = new MainWorld(commands, frame?.frameElement ?? null);
        this.#clickChecks = new ClickCheckWorld(commands, () => this.frameId());
        this.#input = new CdpPageInput(commands, {
            viewportOffset: () => this.#viewportOffset(),
            callForStringAsInput: async (pageFunction, inputs, hasStepEnded) =>
                textOfCall(await this.#call(pageFunction, inputs, AWAITED_VALUE, hasStepEnded)),
        });
        this.#whenLoaded = new WhenLoaded(commands);
    }

    async navigate(
        url: string,
        timeoutMilliseconds: number,
        scripts: "enabled" | "disabled",
    ): Promise<void> {
        const frameId = this.#frame?.frameId;
        // Script execution is a setting of the whole page, so only the top document's navigate
        // changes it; it stays as set until the next one.
        if (frameId === undefined) {
            const shouldDisable = scripts === "disabled";
            if (shouldDisable !== this.#scriptsDisabled) {
                await this.#commands.ask(SET_SCRIPT_EXECUTION_DISABLED, { value: shouldDisable });
                this.#scriptsDisabled = shouldDisable;
            }
        }
        const watch = this.#commands.watch;
        const loaded =
            frameId === undefined
                ? this.#whenLoaded.topDocument(timeoutMilliseconds)
                : this.#whenLoaded.frame(frameId, timeoutMilliseconds);
        // A page that opens a dialog as it loads loads no further until a step answers it, and only a
        // step after this navigate can, so the navigate ends as one opens. Only one that opens from
        // now on counts: what the page was showing before is ended by the navigation.
        const nextDialog = watch.nextDialogOpened();
        const heldByDialog = nextDialog.promise.then((): never => {
            throw new PageHeldByDialog(NAVIGATE.method);
        });
        try {
            await Promise.race([this.#sendAndLoad(url, frameId, loaded), heldByDialog]);
        } finally {
            nextDialog.cancel();
            loaded.cancel();
        }
    }

    async #sendAndLoad(url: string, frameId: string | undefined, loaded: LoadWait): Promise<void> {
        const watch = this.#commands.watch;
        // Sent whatever holds the page: a navigation away ends a dialog, and the browser answers
        // it. The browser answers once the document's own request has gone on, which a refused
        // decision stops.
        const navigated = await watch.failingOnRefusedDecision(
            watch.ask(NAVIGATE, { url, ...(frameId === undefined ? {} : { frameId }) }),
        );
        // An HTTP error status with an empty body is a page the server did send: the browser
        // shows its own error page for it, and the plan's checks decide what that means.
        const navigationError = navigated.errorText ?? "";
        if (navigationError !== "" && navigationError !== HTTP_ERROR_STATUS) {
            throw new Error(navigationError);
        }
        const notLoaded = await watch.failingOnRefusedDecision(
            watch.failingOnCrash(NAVIGATE.method, loaded.promise),
        );
        if (notLoaded !== null) {
            throw new Error(notLoaded);
        }
    }

    // The world this document is read through. Asked for at each read, since the browser gives a
    // document one for each name, and a document that has changed since has a new one.
    async #readingWorld(): Promise<number> {
        return this.#commands.isolatedWorld(await this.frameId());
    }

    // The document object, in the world given.
    async #documentObject(world: number): Promise<string> {
        const evaluated = await this.#commands.ask(EVALUATE, {
            expression: "document",
            contextId: world,
        });
        if (evaluated.result.objectId === undefined) {
            throw new Error("no document");
        }
        return evaluated.result.objectId;
    }

    // With `hasStepEnded`, the call is part of an input and goes only while its step lasts.
    async #call(
        pageFunction: PageFunction,
        inputs: readonly PageArgument<string>[],
        delivery: CallDelivery,
        hasStepEnded: HasStepEnded | null = null,
    ): Promise<CallResult> {
        const objectId = await this.#documentObject(await this.#readingWorld());
        const parameters = {
            functionDeclaration: pageFunction.toString(),
            objectId,
            arguments: callArgumentsOf(inputs),
            ...delivery,
        };
        const called = await (hasStepEnded === null
            ? this.#commands.ask(CALL_FUNCTION_ON, parameters)
            : this.#commands.askAsInput(CALL_FUNCTION_ON, parameters, hasStepEnded));
        throwIfThePageThrew(called);
        return called;
    }

    async callForString(
        pageFunction: PageFunction,
        inputs: readonly PageArgument<string>[],
    ): Promise<string> {
        return textOfCall(await this.#call(pageFunction, inputs, AWAITED_VALUE));
    }

    callForStringInMainWorld(
        pageFunction: PageFunction,
        inputs: readonly PageArgument<string>[],
    ): Promise<string> {
        return this.#mainWorld.callForString(pageFunction, inputs);
    }

    async twoFramesLater(): Promise<void> {
        try {
            await this.callForString(afterTwoFrames, []);
        } catch (error) {
            const canNoMoreFramesCome =
                error instanceof PageHeldByDialog ||
                this.#commands.watch.crashed() ||
                isDocumentGone(error);
            if (!canNoMoreFramesCome) {
                throw error;
            }
        }
    }

    async callForElements(
        pageFunction: PageFunction,
        inputs: readonly PageArgument<string>[],
    ): Promise<string[]> {
        const list = (await this.#call(pageFunction, inputs, AWAITED_OBJECT)).result.objectId;
        // Every function called here returns an array, so no object means the page got in the way.
        if (list === undefined) {
            throw new Error("the page gave no list of elements");
        }
        const properties = await this.#commands.ask(GET_PROPERTIES, {
            objectId: list,
            ownProperties: true,
        });
        return properties.result
            .filter((property) => /^\d+$/.test(property.name))
            .map((property) => {
                const handle = property.value?.objectId;
                if (handle === undefined) {
                    throw new MalformedBrowserReply(
                        GET_PROPERTIES.method,
                        `result.${property.name}.value.objectId`,
                    );
                }
                return handle;
            });
    }

    withPressCheck<Value>(
        arm: PageFunction,
        element: string,
        use: (check: PressCheck) => Promise<Value>,
    ): Promise<Value> {
        return this.#clickChecks.withPressCheck(arm, element, use);
    }

    callInEveryFramedDocumentOutOfReach(pageFunction: PageFunction): Promise<void> {
        return this.#clickChecks.callInEveryFramedDocument(pageFunction);
    }

    async byRole(role: string, name: string): Promise<string[]> {
        const world = await this.#readingWorld();
        const root = (
            await this.#commands.ask(DESCRIBE_NODE, {
                objectId: await this.#documentObject(world),
            })
        ).node.backendNodeId;
        const queried = await this.#commands.ask(QUERY_ACCESSIBILITY_TREE, {
            backendNodeId: root,
            role: role === "img" ? "image" : role,
            accessibleName: name,
        });
        const handles: string[] = [];
        for (const node of queried.nodes) {
            if (node.ignored || node.backendDOMNodeId === undefined) {
                continue;
            }
            const resolved = await this.#commands.ask(RESOLVE_NODE, {
                backendNodeId: node.backendDOMNodeId,
                executionContextId: world,
            });
            handles.push(resolved.object.objectId);
        }
        return handles;
    }

    roleAndName(element: string): Promise<RoleAndName> {
        return roleAndNameOf(this.#commands, element);
    }

    exposedStates(element: string): Promise<ExposedStates> {
        return exposedStatesOf(this.#commands, element);
    }

    accessibilityTree(): Promise<A11yNode> {
        return accessibilityTreeOf(this.#commands, this.#frame?.frameId);
    }

    // Where this document's viewport starts in the top document's viewport: the sum of the frame
    // offsets on the way down. Mouse events are dispatched to the top document.
    async #viewportOffset(): Promise<Point> {
        const frame = this.#frame;
        if (frame === null) {
            return { x: 0, y: 0 };
        }
        const above = await frame.parent.#viewportOffset();
        const offset = decodePoint(
            await frame.parent.callForString(frameContentOffset, [{ element: frame.frameElement }]),
        );
        return { x: above.x + offset.x, y: above.y + offset.y };
    }

    // Called on the element itself, in whichever world found it, since this document's world may be
    // a later document's by now.
    async isElementGone(element: string): Promise<boolean> {
        const watch = this.#commands.watch;
        if (watch.crashed()) {
            return true;
        }
        try {
            const called = await this.#commands.ask(CALL_FUNCTION_ON, {
                functionDeclaration: isConnectedToItsDocument.toString(),
                objectId: element,
                returnByValue: true,
            });
            throwIfThePageThrew(called);
            if (typeof called.result.value !== "boolean") {
                throw new MalformedBrowserReply(CALL_FUNCTION_ON.method, "result.result.value");
            }
            return !called.result.value;
        } catch (error) {
            if (watch.crashed() || isLostObject(error)) {
                return true;
            }
            throw error;
        }
    }

    async frameId(): Promise<string> {
        const framed = this.#frame?.frameId;
        if (framed !== undefined) {
            return framed;
        }
        this.#topFrameId ??= (await this.#commands.ask(GET_FRAME_TREE, {})).frameTree.frame.id;
        return this.#topFrameId;
    }

    async canPressStartAnything(element: string, at: Point): Promise<boolean> {
        const passed = await this.callForElements(nodesAPressPasses, [{ element }, at.x, at.y]);
        const actsByItself = await this.callForString(
            pressActsByItself,
            passed.map((node) => ({ element: node })),
        );
        if (actsByItself === "yes") {
            return true;
        }
        return this.#mainWorld.hasPressListener(passed);
    }

    isCustomElementEnabled(element: string): Promise<boolean> {
        return this.#mainWorld.isCustomElementEnabled(element);
    }

    click(
        at: Point,
        centreOfElementNow: () => Promise<Point | null>,
        hasStepEnded: HasStepEnded,
    ): Promise<PressSent> {
        return this.#input.click(at, centreOfElementNow, hasStepEnded);
    }

    hover(at: Point, hasStepEnded: HasStepEnded): Promise<void> {
        return this.#input.hover(at, hasStepEnded);
    }

    fill(element: string, value: string, hasStepEnded: HasStepEnded): Promise<void> {
        return this.#input.fill(element, value, hasStepEnded);
    }

    press(
        element: string,
        key: Key,
        modifiers: readonly HeldModifierKey[],
        hasStepEnded: HasStepEnded,
    ): Promise<void> {
        return this.#input.press(element, key, modifiers, hasStepEnded);
    }

    setFiles(element: string, paths: readonly string[], hasStepEnded: HasStepEnded): Promise<void> {
        return this.#input.setFiles(element, paths, hasStepEnded);
    }

    select(element: string, option: string, hasStepEnded: HasStepEnded): Promise<SelectOutcome> {
        return this.#input.select(element, option, hasStepEnded);
    }

    callScript(
        source: string,
        scriptArguments: Readonly<Record<string, string | number | boolean>>,
        maximumResultBytes: number,
        hasStepEnded: HasStepEnded,
    ): Promise<ScriptCallOutcome> {
        return this.#mainWorld.callScript(
            source,
            scriptArguments,
            maximumResultBytes,
            hasStepEnded,
        );
    }

    async frame(element: string): Promise<PageWithInput<string> | null> {
        const described = await this.#commands.ask(DESCRIBE_NODE, { objectId: element });
        const frameId = described.node.frameId;
        if (frameId === undefined) {
            return null;
        }
        try {
            await this.#commands.isolatedWorld(frameId);
        } catch (error) {
            // A frame whose document runs in another renderer process has no world in this session.
            // Any other failure says nothing about the frame.
            if (this.#commands.watch.crashed() || !isFrameOutOfReach(error)) {
                throw error;
            }
            return null;
        }
        return new CdpPage(this.#commands, { parent: this, frameElement: element, frameId });
    }

    async unreachableUrl(): Promise<string | null> {
        const { frameTree } = await this.#commands.ask(GET_FRAME_TREE, {});
        const frameId = this.#frame?.frameId;
        const find = (tree: FrameTree): FrameTree | undefined => {
            if (frameId === undefined || tree.frame.id === frameId) {
                return tree;
            }
            return (tree.childFrames ?? []).map(find).find((found) => found !== undefined);
        };
        return find(frameTree)?.frame.unreachableUrl ?? null;
    }

    async screenshotPng(): Promise<Uint8Array> {
        const captured = await this.#commands.ask(CAPTURE_SCREENSHOT, { format: "png" });
        return new Uint8Array(Buffer.from(captured.data, "base64"));
    }
}
