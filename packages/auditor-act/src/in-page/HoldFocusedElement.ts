/// <reference lib="dom" />
// A handle the Tab walk keeps on the deepest focused element, on the page's window, through shadow
// roots and same-origin frames, so a later read can find the same element.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values.

type WindowHoldingFocus = Window & { __focusedElement?: Element | null };

export function holdFocusedElement(): boolean {
    let element: Element | null = document.activeElement;
    for (;;) {
        if (element === null) {
            break;
        }
        const shadowActive: Element | null = element.shadowRoot?.activeElement ?? null;
        if (shadowActive !== null) {
            element = shadowActive;
            continue;
        }
        const frameDocument: Document | null =
            element.tagName === "IFRAME" || element.tagName === "FRAME"
                ? (element as HTMLIFrameElement).contentDocument
                : null;
        if (
            frameDocument !== null &&
            frameDocument.activeElement !== null &&
            frameDocument.activeElement !== frameDocument.body
        ) {
            element = frameDocument.activeElement;
            continue;
        }
        break;
    }
    (window as WindowHoldingFocus).__focusedElement = element;
    return element !== null;
}

// Takes focus off the held element, so a screenshot can show what focus changed.
export function blurHeldElement(): void {
    const element = (window as WindowHoldingFocus).__focusedElement as
        HTMLElement | null | undefined;
    element?.blur();
}

// Gives the held element its focus back, without scrolling to it.
export function refocusHeldElement(): void {
    const element = (window as WindowHoldingFocus).__focusedElement as
        HTMLElement | null | undefined;
    element?.focus({ preventScroll: true });
}
