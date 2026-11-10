/// <reference lib="dom" />
// The deepest focused element across shadow roots and same-origin frames.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values.

type ActiveElementHolderInPage = {
    readonly element: Element;
    readonly box: readonly number[];
    readonly view: readonly number[];
};

// The element, with its box in page and in viewport coordinates, or null when focus is on no element.
export function activeElementHolder(): ActiveElementHolderInPage | null {
    let element: Element | null = document.activeElement;
    let offsetX = 0;
    let offsetY = 0;
    for (;;) {
        if (element === null) {
            return null;
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
        if (frameDocument !== null && frameDocument.activeElement !== null) {
            const frame = element.getBoundingClientRect();
            offsetX += frame.left + element.clientLeft;
            offsetY += frame.top + element.clientTop;
            element = frameDocument.activeElement;
            if (element === frameDocument.body || element === frameDocument.documentElement) {
                return null;
            }
            continue;
        }
        break;
    }
    if (element === document.body || element === document.documentElement) {
        return null;
    }
    const rectangle = element.getBoundingClientRect();
    return {
        element,
        box: [
            rectangle.left + offsetX + window.scrollX,
            rectangle.top + offsetY + window.scrollY,
            rectangle.width,
            rectangle.height,
        ],
        view: [
            rectangle.left + offsetX,
            rectangle.top + offsetY,
            rectangle.width,
            rectangle.height,
        ],
    };
}

export function boxesOfHolder(this: ActiveElementHolderInPage): readonly (readonly number[])[] {
    return [this.box, this.view];
}

export function elementOfHolder(this: ActiveElementHolderInPage): Element {
    return this.element;
}
