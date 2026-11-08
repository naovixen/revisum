/// <reference lib="dom" />
// What a screenshot paints over, and what it checks is hidden.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// Paints a solid black box over every element matching the selectors, in any open shadow root too:
// an element a locator can find must be one a mask can reach.
export function maskElements(selectors: readonly string[]): string {
    const selectorList = selectors.join(",");
    if (selectorList === "") {
        return "0";
    }
    const elements: Element[] = [];
    const roots: (Document | ShadowRoot)[] = [document];
    for (const root of roots) {
        elements.push(...Array.from(root.querySelectorAll(selectorList)));
        for (const element of Array.from(root.querySelectorAll("*"))) {
            const shadowRoot = Reflect.get(Element.prototype, "shadowRoot", element);
            if (shadowRoot !== null) {
                roots.push(shadowRoot);
            }
        }
    }
    for (const element of elements) {
        const rectangle = Element.prototype.getBoundingClientRect.call(element);
        const overlay = document.createElement("div");
        overlay.setAttribute("data-mask-overlay", "");
        overlay.style.cssText = `position:fixed;left:${rectangle.x}px;top:${rectangle.y}px;width:${rectangle.width}px;height:${rectangle.height}px;background:#000;z-index:2147483647;pointer-events:none`;
        document.documentElement.appendChild(overlay);
    }
    return String(elements.length);
}

// Every element in the document, or in an open shadow root of it, that holds a framed document.
export function framedDocumentElements(): Element[] {
    const frames: Element[] = [];
    const roots: (Document | ShadowRoot)[] = [document];
    for (const root of roots) {
        frames.push(...Array.from(root.querySelectorAll("iframe,frame")));
        for (const element of Array.from(root.querySelectorAll("*"))) {
            const shadowRoot = Reflect.get(Element.prototype, "shadowRoot", element);
            if (shadowRoot !== null) {
                roots.push(shadowRoot);
            }
        }
    }
    return frames;
}

// What every field in the document holds, as JSON. The caller only compares it, and keeps none of it.
export function fieldValues(): string {
    const fields = [
        ...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("input,textarea"),
    ].map((field) => field.value);
    const editable = [
        ...document.querySelectorAll('[contenteditable]:not([contenteditable="false"])'),
    ].map((element) => Reflect.get(Node.prototype, "textContent", element));
    return JSON.stringify([...fields, ...editable]);
}

// Paints the same box over each of the given elements. unmaskElements takes these away too.
export function maskGivenElements(...elements: Element[]): string {
    for (const element of elements) {
        const rectangle = Element.prototype.getBoundingClientRect.call(element);
        const overlay = document.createElement("div");
        overlay.setAttribute("data-mask-overlay", "");
        overlay.style.cssText = `position:fixed;left:${rectangle.x}px;top:${rectangle.y}px;width:${rectangle.width}px;height:${rectangle.height}px;background:#000;z-index:2147483647;pointer-events:none`;
        document.documentElement.appendChild(overlay);
    }
    return String(elements.length);
}

export function unmaskElements(): string {
    for (const overlay of Array.from(document.querySelectorAll("[data-mask-overlay]"))) {
        overlay.remove();
    }
    return "ok";
}

// Waits for web fonts; returns the font set's status.
export async function fontsReady(): Promise<string> {
    await document.fonts.ready;
    return document.fonts.status;
}
