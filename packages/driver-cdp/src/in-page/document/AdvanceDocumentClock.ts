/// <reference lib="dom" />
// The run's virtual clock in a document.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// Advances this document's virtual clock to `target` milliseconds after the frozen start, through
// the determinism kit's advance controller in the page's main world, where the page's timers are.
// A document without the controller, such as one loaded with scripts off, fires nothing. Gives
// how many callbacks fired and whether the limit stopped it.
export async function advanceDocumentClock(
    controllerKey: string,
    target: number,
    mode: string,
    maximumCallbacks: number,
): Promise<unknown> {
    type Controller = {
        advanceTo(target: number, mode: string, maximumCallbacks: number): Promise<unknown>;
    };
    const controller = (window as unknown as Record<symbol, Controller | undefined>)[
        Symbol.for(controllerKey)
    ];
    if (controller === undefined) {
        return { fired: 0, runaway: false };
    }
    return controller.advanceTo(target, mode, maximumCallbacks);
}
