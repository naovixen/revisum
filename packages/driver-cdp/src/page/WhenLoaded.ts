// Waits for a document to load, under one deadline. The top document has loaded at its load event; a
// frame once it stops loading.
import { FRAME_STOPPED_LOADING, LOAD_EVENT_FIRED } from "../connection/BrowserEvent.ts";
import type { PageCommands } from "./PageCommands.ts";

// Resolves as the document has loaded, with null, or with what to say when it has not in time.
export type LoadWait = { readonly promise: Promise<string | null>; cancel(): void };

export class WhenLoaded {
    readonly #commands: PageCommands;

    constructor(commands: PageCommands) {
        this.#commands = commands;
    }

    topDocument(timeoutMilliseconds: number): LoadWait {
        return this.#waitFor(
            (loaded) => this.#commands.listen(LOAD_EVENT_FIRED, loaded),
            `${LOAD_EVENT_FIRED.name}: timeout after ${timeoutMilliseconds} ms`,
            timeoutMilliseconds,
        );
    }

    frame(frameId: string, timeoutMilliseconds: number): LoadWait {
        return this.#waitFor(
            (loaded) =>
                this.#commands.listen(FRAME_STOPPED_LOADING, (stopped) => {
                    if (stopped.frameId === frameId) {
                        loaded();
                    }
                }),
            `the frame did not load within ${timeoutMilliseconds} ms`,
            timeoutMilliseconds,
        );
    }

    #waitFor(
        listenForLoad: (loaded: () => void) => () => void,
        notInTime: string,
        timeoutMilliseconds: number,
    ): LoadWait {
        let stopListening = (): void => undefined;
        let timer: NodeJS.Timeout | undefined;
        const promise = new Promise<string | null>((resolveLoaded) => {
            stopListening = listenForLoad(() => {
                clearTimeout(timer);
                stopListening();
                resolveLoaded(null);
            });
            timer = setTimeout(() => {
                stopListening();
                resolveLoaded(notInTime);
            }, timeoutMilliseconds);
        });
        return {
            promise,
            cancel: () => {
                clearTimeout(timer);
                stopListening();
            },
        };
    }
}
