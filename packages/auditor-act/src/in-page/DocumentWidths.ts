/// <reference lib="dom" />
// The document's scroll width and client width. It runs inside the page and is sent with toString(),
// so it is self-contained: no imports and no closures over Node values.

export function documentWidths(): { readonly scrollWidth: number; readonly clientWidth: number } {
    return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    };
}
