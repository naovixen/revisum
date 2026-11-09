// The click checks of one document, kept in a script world of the driver's own where the page's
// scripts cannot reach them, and what each reports of its press.
import { BINDING_CALLED } from "../../connection/BrowserEvent.ts";
import { GET_FRAME_TREE } from "../../connection/BrowserCommand.ts";
import {
    CALL_FUNCTION_ON,
    RELEASE_OBJECT,
    RELEASE_OBJECT_GROUP,
} from "../../connection/domains/RuntimeDomain.ts";
import { DESCRIBE_NODE, RESOLVE_NODE } from "../../connection/domains/DomDomain.ts";
import { errorText } from "../../connection/ErrorText.ts";
import type { FrameTree } from "../../connection/RemoteObject.ts";
import { throwIfThePageThrew } from "../CallDelivery.ts";
import { isDocumentGone, isLostObject } from "../failures/LostObject.ts";
import type { PageCommands } from "../PageCommands.ts";
import type { PageFunction } from "../PageFunction.ts";
import { PageHeldByDialog } from "../failures/PageHeldByDialog.ts";
import type { CheckRead, PressCheck } from "./PressCheck.ts";
import { PRESS_REPORT_BINDING, WorldName } from "../WorldName.ts";

// How long what a check reported before a dialog opened, or its document went, is given to arrive. It
// was on its way before either, by another route to the driver. A fixed wait, as no sync point exists
// while a dialog holds the renderer: a command that could come back after the reports needs the
// renderer to answer it, and that is what the dialog stops.
const REPORTS_ARRIVE_MILLISECONDS = 100;

const pause = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));

// A kept check's objects are grouped by frame, so that one nobody holds any more can still be let go,
// and letting go of one document's cannot touch a check that is live in another.
const outOfReachObjectGroup = (frameId: string): string => `driver-kept-out-of-reach-${frameId}`;

// The ids of the frame and of every frame inside it, or none when it is no longer in the tree.
function frameIdsInside(tree: FrameTree, frameId: string): readonly string[] {
    if (tree.frame.id === frameId) {
        const everyFrame = (inside: FrameTree): readonly string[] => [
            inside.frame.id,
            ...(inside.childFrames ?? []).flatMap(everyFrame),
        ];
        return everyFrame(tree);
    }
    return (tree.childFrames ?? []).flatMap((child) => frameIdsInside(child, frameId));
}

export class ClickCheckWorld {
    readonly #commands: PageCommands;
    readonly #frameId: () => Promise<string>;

    constructor(commands: PageCommands, frameId: () => Promise<string>) {
        this.#commands = commands;
        this.#frameId = frameId;
    }

    async withPressCheck<Value>(
        arm: PageFunction,
        element: string,
        use: (check: PressCheck) => Promise<Value>,
    ): Promise<Value> {
        const frameId = await this.#frameId();
        const executionContextId = await this.#commands.isolatedWorld(
            frameId,
            WorldName.ClickCheck,
        );
        const pressId = this.#commands.watch.nextPressId();
        const reported = new Set<string>();
        const stopListening = this.#commands.listen(BINDING_CALLED, ({ name, payload }) => {
            const [fromPress, what] = payload.split(" ");
            if (name === PRESS_REPORT_BINDING && fromPress === pressId && what !== undefined) {
                reported.add(what);
            }
        });
        try {
            const check = await this.#armOutOfReach(
                arm,
                element,
                executionContextId,
                frameId,
                pressId,
            );
            try {
                return await use({
                    read: (pageFunction) => this.#readCheck(check, pageFunction),
                    reports: async () => {
                        await pause(REPORTS_ARRIVE_MILLISECONDS);
                        return reported;
                    },
                });
            } finally {
                // Not waited for: what the step needs is in, and the browser answers nothing to a page
                // that has started to navigate, which a click often makes it do.
                void this.#commands.releaseKept(RELEASE_OBJECT, { objectId: check });
            }
        } finally {
            stopListening();
        }
    }

    async callInEveryFramedDocument(pageFunction: PageFunction): Promise<void> {
        const { frameTree } = await this.#commands.ask(GET_FRAME_TREE, {});
        for (const frameId of frameIdsInside(frameTree, await this.#frameId())) {
            if (await this.#hasTakenSomethingOff(frameId, pageFunction)) {
                // Not waited for, as a page that has started to navigate answers nothing, and the
                // browser has it before anything sent after this. While a dialog held the page it
                // could not be let go.
                void this.#commands.releaseKept(RELEASE_OBJECT_GROUP, {
                    objectGroup: outOfReachObjectGroup(frameId),
                });
            }
        }
    }

    async #armOutOfReach(
        arm: PageFunction,
        element: string,
        executionContextId: number,
        frameId: string,
        pressId: string,
    ): Promise<string> {
        const described = await this.#commands.ask(DESCRIBE_NODE, { objectId: element });
        const resolved = await this.#commands.ask(RESOLVE_NODE, {
            backendNodeId: described.node.backendNodeId,
            executionContextId,
        });
        const elementInWorld = resolved.object.objectId;
        try {
            const called = await this.#commands.ask(CALL_FUNCTION_ON, {
                functionDeclaration: arm.toString(),
                executionContextId,
                arguments: [
                    { objectId: elementInWorld },
                    { value: PRESS_REPORT_BINDING },
                    { value: pressId },
                ],
                returnByValue: false,
                objectGroup: outOfReachObjectGroup(frameId),
            });
            throwIfThePageThrew(called);
            const kept = called.result.objectId;
            if (kept === undefined) {
                throw new Error("the page function gave no object to keep");
            }
            return kept;
        } finally {
            await this.#commands.releaseKept(RELEASE_OBJECT, { objectId: elementInWorld });
        }
    }

    // A read says what became of the check in every case, since each one means something to a press.
    async #readCheck(check: string, pageFunction: PageFunction): Promise<CheckRead> {
        try {
            const called = await this.#commands.ask(CALL_FUNCTION_ON, {
                functionDeclaration: pageFunction.toString(),
                objectId: check,
                returnByValue: true,
            });
            throwIfThePageThrew(called);
            return { kind: "answered", value: called.result.value };
        } catch (error) {
            if (error instanceof PageHeldByDialog) {
                return { kind: "held-by-dialog" };
            }
            return isLostObject(error)
                ? { kind: "document-gone" }
                : { kind: "failed", detail: errorText(error) };
        }
    }

    // A document that has gone took its check with it, so there are no listeners left to take off.
    async #hasTakenSomethingOff(frameId: string, pageFunction: PageFunction): Promise<boolean> {
        try {
            const executionContextId = await this.#commands.isolatedWorld(
                frameId,
                WorldName.ClickCheck,
            );
            const called = await this.#commands.ask(CALL_FUNCTION_ON, {
                functionDeclaration: pageFunction.toString(),
                executionContextId,
                returnByValue: true,
            });
            throwIfThePageThrew(called);
            return called.result.value === true;
        } catch (error) {
            if (isDocumentGone(error)) {
                return false;
            }
            throw error;
        }
    }
}
