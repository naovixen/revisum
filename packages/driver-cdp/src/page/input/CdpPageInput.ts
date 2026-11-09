// The input one document is sent: the pointer, the keyboard, files and choices. Each command goes
// only while its step lasts, except the release of what it has already pressed down.
import type { Key } from "@revisum/contracts";
import { MalformedBrowserReply } from "../../connection/MalformedBrowserReply.ts";
import { CALL_FUNCTION_ON } from "../../connection/domains/RuntimeDomain.ts";
import { SET_FILE_INPUT_FILES } from "../../connection/domains/DomDomain.ts";
import {
    DISPATCH_KEY_EVENT,
    DISPATCH_MOUSE_EVENT,
    INSERT_TEXT,
} from "../../connection/domains/InputDomain.ts";
import {
    focusAndSelect,
    focusElement,
    selectOption,
} from "../../in-page/elements/FocusAndSelect.ts";
import { isSamePoint } from "./DecodePoint.ts";
import type { HeldModifierKey } from "./HeldModifierKeys.ts";
import {
    KEY_DEFINITIONS,
    LEFT_KEY,
    MODIFIER_KEY_DEFINITIONS,
    heldKeyDefinition,
    modifierMask,
    type KeyDefinition,
} from "./KeyDefinitions.ts";
import type { PageCommands } from "../PageCommands.ts";
import type { PageFunction } from "../PageFunction.ts";
import {
    SelectOutcome,
    type HasStepEnded,
    type PageArgument,
    type Point,
} from "../PageOperations.ts";
import { PressSent } from "../checks/PressCheck.ts";
import { StepHasEnded } from "../failures/StepHasEnded.ts";

// For the release of a key or button input has already sent down, which goes even once its step has ended.
const SENT_EVEN_ONCE_THE_STEP_HAS_ENDED: HasStepEnded = () => false;

// How the input reaches the document: where its viewport starts in the top document's, and a call of
// a page function in the document's reading world, as part of an input.
export type InputDocument = {
    readonly viewportOffset: () => Promise<Point>;
    readonly callForStringAsInput: (
        pageFunction: PageFunction,
        inputs: readonly PageArgument<string>[],
        hasStepEnded: HasStepEnded,
    ) => Promise<string>;
};

export class CdpPageInput {
    readonly #commands: PageCommands;
    readonly #document: InputDocument;

    constructor(commands: PageCommands, document: InputDocument) {
        this.#commands = commands;
        this.#document = document;
    }

    async click(
        at: Point,
        centreOfElementNow: () => Promise<Point | null>,
        hasStepEnded: HasStepEnded,
    ): Promise<PressSent> {
        const offset = await this.#document.viewportOffset();
        const point = { x: at.x + offset.x, y: at.y + offset.y };
        const pressed = { ...point, button: "left" as const, clickCount: 1 };
        await this.#commands.sendInput(
            DISPATCH_MOUSE_EVENT,
            { type: "mouseMoved", ...point },
            hasStepEnded,
        );
        // A parent page can move this document's frame, which a read inside the frame cannot see, so
        // the aim is only good if both still agree. The element's own read comes last, closest to the
        // press.
        const offsetNow = await this.#document.viewportOffset();
        const centre = await centreOfElementNow();
        if (centre === null || !isSamePoint(centre, at) || !isSamePoint(offsetNow, offset)) {
            return PressSent.NotSent;
        }
        await this.#commands.sendInput(
            DISPATCH_MOUSE_EVENT,
            { type: "mousePressed", ...pressed },
            hasStepEnded,
        );
        if (this.#commands.watch.openDialog() !== null) {
            return PressSent.HeldAtThePress;
        }
        // A press sent is released even once the step has ended, so no button is left held down.
        await this.#commands.sendInput(
            DISPATCH_MOUSE_EVENT,
            { type: "mouseReleased", ...pressed },
            SENT_EVEN_ONCE_THE_STEP_HAS_ENDED,
        );
        return PressSent.Released;
    }

    async hover(at: Point, hasStepEnded: HasStepEnded): Promise<void> {
        const offset = await this.#document.viewportOffset();
        await this.#commands.sendInput(
            DISPATCH_MOUSE_EVENT,
            { type: "mouseMoved", x: at.x + offset.x, y: at.y + offset.y },
            hasStepEnded,
        );
    }

    async fill(element: string, value: string, hasStepEnded: HasStepEnded): Promise<void> {
        await this.#document.callForStringAsInput(focusAndSelect, [{ element }], hasStepEnded);
        if (value === "") {
            await this.#pressKey(KEY_DEFINITIONS.Backspace, 0, hasStepEnded);
        } else {
            await this.#commands.sendInput(INSERT_TEXT, { text: value }, hasStepEnded);
        }
    }

    async press(
        element: string,
        key: Key,
        modifiers: readonly HeldModifierKey[],
        hasStepEnded: HasStepEnded,
    ): Promise<void> {
        await this.#document.callForStringAsInput(focusElement, [{ element }], hasStepEnded);
        const held: HeldModifierKey[] = [];
        try {
            for (const modifier of modifiers) {
                const definition = MODIFIER_KEY_DEFINITIONS[modifier];
                await this.#commands.sendInput(
                    DISPATCH_KEY_EVENT,
                    {
                        type: "rawKeyDown",
                        key: definition.key,
                        code: definition.code,
                        windowsVirtualKeyCode: definition.keyCode,
                        location: LEFT_KEY,
                        modifiers: modifierMask([...held, modifier]),
                    },
                    hasStepEnded,
                );
                held.push(modifier);
                if (this.#commands.watch.openDialog() !== null) {
                    return;
                }
            }
            await this.#pressKey(
                heldKeyDefinition(KEY_DEFINITIONS[key], held),
                modifierMask(held),
                hasStepEnded,
            );
        } catch (error) {
            if (error instanceof StepHasEnded) {
                await this.#releaseModifierKeys(held);
            }
            throw error;
        }
        await this.#releaseModifierKeys(held);
    }

    async setFiles(
        element: string,
        paths: readonly string[],
        hasStepEnded: HasStepEnded,
    ): Promise<void> {
        await this.#commands.askAsInput(
            SET_FILE_INPUT_FILES,
            { files: [...paths], objectId: element },
            hasStepEnded,
        );
    }

    async select(
        element: string,
        option: string,
        hasStepEnded: HasStepEnded,
    ): Promise<SelectOutcome> {
        const chosen = await this.#document.callForStringAsInput(
            selectOption,
            [{ element }, option],
            hasStepEnded,
        );
        const outcome = Object.values(SelectOutcome).find((known) => known === chosen);
        if (outcome === undefined) {
            throw new MalformedBrowserReply(CALL_FUNCTION_ON.method, "result.result.value");
        }
        return outcome;
    }

    // Lets go of the modifier keys held down, in reverse, unless a dialog holds the page. They go even
    // once the step has ended, as no new key is pressed by them and a key left down would change later
    // input.
    async #releaseModifierKeys(held: readonly HeldModifierKey[]): Promise<void> {
        const stillHeld = [...held];
        for (const modifier of [...held].reverse()) {
            if (this.#commands.watch.openDialog() !== null) {
                return;
            }
            stillHeld.splice(stillHeld.indexOf(modifier), 1);
            const definition = MODIFIER_KEY_DEFINITIONS[modifier];
            await this.#commands.sendInput(
                DISPATCH_KEY_EVENT,
                {
                    type: "keyUp",
                    key: definition.key,
                    code: definition.code,
                    windowsVirtualKeyCode: definition.keyCode,
                    location: LEFT_KEY,
                    modifiers: modifierMask(stillHeld),
                },
                SENT_EVEN_ONCE_THE_STEP_HAS_ENDED,
            );
        }
    }

    // A key sent down is let go even once the step has ended, as a mouse press is released.
    async #pressKey(
        definition: KeyDefinition,
        modifiers: number,
        hasStepEnded: HasStepEnded,
    ): Promise<void> {
        const common = {
            key: definition.key,
            code: definition.code,
            windowsVirtualKeyCode: definition.keyCode,
            modifiers,
        };
        if (definition.text === undefined) {
            await this.#commands.sendInput(
                DISPATCH_KEY_EVENT,
                { type: "rawKeyDown", ...common },
                hasStepEnded,
            );
        } else {
            await this.#commands.sendInput(
                DISPATCH_KEY_EVENT,
                { type: "keyDown", ...common, text: definition.text },
                hasStepEnded,
            );
        }
        if (this.#commands.watch.openDialog() !== null) {
            return;
        }
        await this.#commands.sendInput(
            DISPATCH_KEY_EVENT,
            { type: "keyUp", ...common },
            SENT_EVEN_ONCE_THE_STEP_HAS_ENDED,
        );
    }
}
