// The own driver's clock port: one virtual time for the whole session. The determinism kit's
// advance controller runs in each frame's main world, where the page's timers are, so an advance
// fires them there; the driver only tells each frame how far to go.
//   - Each page of the session (the first tab and any newTab) registers here. When the plan
//     advances the clock, its pages' timers run on virtual time from their first document on.
//   - An advance moves the session's time first and re-registers the new-document script at the new
//     time, so a document that loads during or after the advance starts there and page time never
//     goes backwards. Then every frame is advanced to that time in turn: tab by tab in the order
//     they opened, the top document first, then its frames in document order.
//   - The callbacks every frame fires count against one limit; past it the advance fails with
//     clock-runaway. Nothing here waits for real time.
import {
    CLOCK_CONTROLLER_KEY,
    failure,
    success,
    virtualClockScript,
    type ClockAdvanceMode,
    type ClockPort,
    type DriverError,
    type Result,
} from "@revisum/contracts";
import {
    ADD_SCRIPT_ON_NEW_DOCUMENT,
    GET_FRAME_TREE,
    REMOVE_SCRIPT_ON_NEW_DOCUMENT,
} from "../connection/BrowserCommand.ts";
import type { FrameTree } from "../connection/RemoteObject.ts";
import {
    CALL_FUNCTION_ON,
    DESCRIBE_NODE,
    EVALUATE,
    GET_FRAME_OWNER,
    RESOLVE_NODE,
} from "../connection/CallFunctionOn.ts";
import { errorText } from "../connection/ErrorText.ts";
import { advanceDocumentClock } from "../in-page/AdvanceDocumentClock.ts";
import { isDocumentGone } from "../page/LostObject.ts";
import type { PageCommand } from "./PageStorage.ts";

// One page of the session, as the clock reaches it.
type ClockPage = {
    readonly command: PageCommand;
    readonly crashed: () => boolean;
    // The identifier of the page's new-document script that starts virtual timers, when registered.
    scriptIdentifier: string | null;
};

// What one frame's controller reported.
type FrameAdvance = { readonly fired: number; readonly runaway: boolean };

const CRASHED: DriverError = {
    code: "target-crashed",
    detail: "the page's renderer died during the clock advance",
};

// Decodes the controller's answer; anything else counts as a frame that fired nothing.
function frameAdvance(value: unknown): FrameAdvance {
    if (typeof value !== "object" || value === null) {
        return { fired: 0, runaway: false };
    }
    const fired: unknown = Reflect.get(value, "fired");
    const runaway: unknown = Reflect.get(value, "runaway");
    return {
        fired: typeof fired === "number" && Number.isInteger(fired) && fired >= 0 ? fired : 0,
        runaway: runaway === true,
    };
}

// Every frame id of a page, top document first, then each frame before its own frames.
function frameIds(tree: FrameTree): string[] {
    return [tree.frame.id, ...(tree.childFrames ?? []).flatMap(frameIds)];
}

export class BrowserClock implements ClockPort {
    readonly #virtualTimers: boolean;
    readonly #pages: ClockPage[] = [];
    // Milliseconds the run has advanced its clock since the frozen start.
    #elapsed = 0;

    // Without virtual timers the plan never advances the clock, so its pages keep real-time timers.
    constructor(hasVirtualTimers: boolean) {
        this.#virtualTimers = hasVirtualTimers;
    }

    // Registers a page before it loads anything; gives the function that forgets it once it closes.
    async watchPage(command: PageCommand, crashed: () => boolean): Promise<() => void> {
        const page: ClockPage = { command, crashed, scriptIdentifier: null };
        if (this.#virtualTimers) {
            await this.#startAt(page, this.#elapsed);
        }
        this.#pages.push(page);
        return () => {
            const index = this.#pages.indexOf(page);
            if (index >= 0) {
                this.#pages.splice(index, 1);
            }
        };
    }

    async advance(
        milliseconds: number,
        mode: ClockAdvanceMode,
        maximumTimers: number,
    ): Promise<Result<void, DriverError>> {
        if (!Number.isInteger(milliseconds) || milliseconds < 1) {
            return failure({
                code: "unsupported-step",
                detail: "an advance is a whole number of milliseconds, at least 1",
            });
        }
        const target = this.#elapsed + milliseconds;
        this.#elapsed = target;
        let fired = 0;
        for (const page of [...this.#pages]) {
            if (page.crashed()) {
                return failure(CRASHED);
            }
            try {
                if (this.#virtualTimers) {
                    await this.#startAt(page, target);
                }
                const { frameTree } = await page.command(GET_FRAME_TREE, {});
                for (const frameId of frameIds(frameTree)) {
                    const advanced = await this.#advanceFrame(
                        page,
                        frameId,
                        frameId === frameTree.frame.id,
                        target,
                        mode,
                        maximumTimers - fired,
                    );
                    fired += advanced.fired;
                    if (advanced.runaway) {
                        return failure({
                            code: "clock-runaway",
                            detail: `the advance would fire more than ${maximumTimers} timer callbacks`,
                        });
                    }
                }
            } catch (error) {
                return failure(
                    page.crashed()
                        ? CRASHED
                        : {
                              code: "page-unreadable",
                              detail: `the clock could not be advanced: ${errorText(error)}`,
                          },
                );
            }
        }
        return success(undefined);
    }

    // Replaces the page's new-document script with one that starts virtual timers at `elapsed`.
    async #startAt(page: ClockPage, elapsed: number): Promise<void> {
        if (page.scriptIdentifier !== null) {
            await page.command(REMOVE_SCRIPT_ON_NEW_DOCUMENT, {
                identifier: page.scriptIdentifier,
            });
            page.scriptIdentifier = null;
        }
        const added = await page.command(ADD_SCRIPT_ON_NEW_DOCUMENT, {
            source: virtualClockScript(elapsed),
        });
        page.scriptIdentifier = added.identifier;
    }

    // Runs one frame's controller in its main world. A frame whose document went away meanwhile
    // fires nothing here: the document that replaced it started at the new time. Any other failure,
    // a throw in the controller included, fails the advance, since a timer that did not run must not
    // look like a page with no timers due.
    async #advanceFrame(
        page: ClockPage,
        frameId: string,
        isTopDocument: boolean,
        target: number,
        mode: ClockAdvanceMode,
        maximumCallbacks: number,
    ): Promise<FrameAdvance> {
        try {
            const documentObject = isTopDocument
                ? await this.#topDocument(page)
                : await this.#frameDocument(page, frameId);
            if (documentObject === null) {
                return { fired: 0, runaway: false };
            }
            const called = await page.command(CALL_FUNCTION_ON, {
                functionDeclaration: advanceDocumentClock.toString(),
                objectId: documentObject,
                awaitPromise: true,
                returnByValue: true,
                arguments: [
                    { value: CLOCK_CONTROLLER_KEY },
                    { value: target },
                    { value: mode },
                    { value: maximumCallbacks },
                ],
            });
            if (called.exceptionDetails !== undefined) {
                throw new Error(
                    `the clock advance threw in a frame: ${called.exceptionDetails.text}`,
                );
            }
            return frameAdvance(called.result.value);
        } catch (error) {
            if (page.crashed() || !isDocumentGone(error)) {
                throw error;
            }
            return { fired: 0, runaway: false };
        }
    }

    // The top document, in the page's main world.
    async #topDocument(page: ClockPage): Promise<string | null> {
        const evaluated = await page.command(EVALUATE, { expression: "document" });
        return evaluated.result.objectId ?? null;
    }

    // An iframe's document, resolved in its own main world, which is where DOM.resolveNode puts a node
    // when no world is named.
    async #frameDocument(page: ClockPage, frameId: string): Promise<string | null> {
        const owner = await page.command(GET_FRAME_OWNER, { frameId });
        const described = await page.command(DESCRIBE_NODE, {
            backendNodeId: owner.backendNodeId,
            depth: 1,
            pierce: true,
        });
        const contentDocument = described.node.contentDocument;
        if (contentDocument === undefined) {
            return null;
        }
        const resolved = await page.command(RESOLVE_NODE, {
            backendNodeId: contentDocument.backendNodeId,
        });
        return resolved.object.objectId;
    }
}
