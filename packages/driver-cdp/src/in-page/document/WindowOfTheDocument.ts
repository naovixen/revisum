/// <reference lib="dom" />
// The window of a document. It runs inside the page and is sent with toString(), so it is
// self-contained: no imports and no closures over Node values.

// Called on a document, as `this`, in the page's main world, where the page's own listeners are.
export function windowOfTheDocument(this: Document): Window | null {
    return this.defaultView;
}
