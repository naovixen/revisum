// The commands one page's documents send, all through the page's watch, so a crashed page or one a
// dialog holds fails them at once.
import type { BrowserCommand } from "../connection/BrowserCommand.ts";
import { CREATE_ISOLATED_WORLD } from "../connection/BrowserCommand.ts";
import type { BrowserEvent } from "../connection/BrowserEvent.ts";
import type { CdpConnection } from "../connection/CdpConnection.ts";
import { errorText } from "../connection/ErrorText.ts";
import { DocumentGone } from "./failures/DocumentGone.ts";
import { FRAME_REMOVED, LOST_OBJECT, isLostObject } from "./failures/LostObject.ts";
import type { HasStepEnded } from "./PageOperations.ts";
import { PageHeldByDialog } from "./failures/PageHeldByDialog.ts";
import type { PageWatch } from "./PageWatch.ts";
import { StepHasEnded } from "./failures/StepHasEnded.ts";
import { WorldName } from "./WorldName.ts";

export class PageCommands {
    readonly #connection: CdpConnection;
    readonly #sessionId: string;
    readonly watch: PageWatch;

    constructor(connection: CdpConnection, sessionId: string, watch: PageWatch) {
        this.#connection = connection;
        this.#sessionId = sessionId;
        this.watch = watch;
    }

    // A command only the running page answers. One about a document that has gone rejects with
    // DocumentGone.
    async ask<CommandParameters, Reply>(
        command: BrowserCommand<CommandParameters, Reply>,
        parameters: NoInfer<CommandParameters>,
    ): Promise<Reply> {
        try {
            return await this.watch.askRunningPage(command, parameters);
        } catch (error) {
            if (
                error instanceof Error &&
                (LOST_OBJECT.test(error.message) || FRAME_REMOVED.test(error.message))
            ) {
                throw new DocumentGone(error.message);
            }
            throw error;
        }
    }

    // A command an input sends that is answered as any other, such as a focus or a choice made in the
    // page. Whether its step has ended is asked in the same turn as the send, so nothing can end the
    // step between.
    askAsInput<CommandParameters, Reply>(
        command: BrowserCommand<CommandParameters, Reply>,
        parameters: NoInfer<CommandParameters>,
        hasStepEnded: HasStepEnded,
    ): Promise<Reply> {
        if (hasStepEnded()) {
            return Promise.reject(new StepHasEnded(command.method));
        }
        return this.ask(command, parameters);
    }

    // Sends input to a page no dialog holds, while its step lasts, asked in the same turn as the send.
    // A dialog that opens while it waits is the input landing, such as the mouse release whose click
    // opens one: this ends then, since the browser answers the command itself only once the dialog is
    // answered.
    async sendInput<CommandParameters>(
        command: BrowserCommand<CommandParameters, void>,
        parameters: NoInfer<CommandParameters>,
        hasStepEnded: HasStepEnded,
    ): Promise<void> {
        if (this.watch.openDialog() !== null) {
            throw new PageHeldByDialog(command.method);
        }
        if (hasStepEnded()) {
            throw new StepHasEnded(command.method);
        }
        const opened = this.watch.dialogOpened();
        try {
            await Promise.race([this.watch.ask(command, parameters), opened.promise]);
        } finally {
            opened.cancel();
        }
    }

    // Never rejects, since a caller is no better off for it: a failure other than the object having
    // gone is kept for the session's close to report. An object whose document or page has gone has
    // gone too, and one a dialog holds goes with its document, so none of these has anything to report.
    async releaseKept<CommandParameters>(
        command: BrowserCommand<CommandParameters, void>,
        parameters: NoInfer<CommandParameters>,
    ): Promise<void> {
        try {
            await this.ask(command, parameters);
        } catch (error) {
            const isOutOfReach =
                error instanceof PageHeldByDialog || this.watch.crashed() || isLostObject(error);
            if (!isOutOfReach) {
                this.watch.noteCleanUpFailure(
                    `a kept object could not be released: ${errorText(error)}`,
                );
            }
        }
    }

    async isolatedWorld(
        frameId: string,
        worldName: WorldName = WorldName.Reading,
    ): Promise<number> {
        const created = await this.ask(CREATE_ISOLATED_WORLD, { frameId, worldName });
        return created.executionContextId;
    }

    // Calls handler for each well-formed `event` of this page until the returned function is called.
    // One the driver cannot read counts as a decision it could not make.
    listen<Payload>(event: BrowserEvent<Payload>, handler: (payload: Payload) => void): () => void {
        return this.#connection.listen(this.#sessionId, event, handler, (detail) => {
            this.watch.noteUnreadableEvent(detail);
        });
    }
}
