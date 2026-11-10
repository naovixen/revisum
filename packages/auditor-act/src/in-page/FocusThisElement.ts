/// <reference lib="dom" />
// Focus on one element, as a programmatic focus does. It runs inside the page and is sent with
// toString(), so it is self-contained: no imports and no closures over Node values.

// Called on the element, as `this`. True when it holds focus afterwards.
export function focusThisElement(this: HTMLElement): boolean {
    this.focus();
    return (
        (this.getRootNode() as Document | ShadowRoot).activeElement === this ||
        document.activeElement === this
    );
}
