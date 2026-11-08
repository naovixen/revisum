/// <reference lib="dom" />
// Hides a text node's text so the background behind it shows, for reading contrast, and shows it again.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values.

// Called on a text node or an element, as `this`. Gives the text's page box.
export function hideSampledText(this: Node): readonly number[] {
    const element = (this.nodeType === 3 ? this.parentElement : this) as HTMLElement;
    const ownerDocument = element.ownerDocument;
    if (ownerDocument.getElementById("contrast-sample-hide-style") === null) {
        const style = ownerDocument.createElement("style");
        style.id = "contrast-sample-hide-style";
        style.textContent =
            "[data-contrast-sample-hide], [data-contrast-sample-hide] * { color: transparent !important; text-shadow: none !important; -webkit-text-stroke: 0 !important; caret-color: transparent !important; text-decoration-color: transparent !important; }";
        const head = ownerDocument.head as HTMLHeadElement | null;
        (head ?? ownerDocument.documentElement).appendChild(style);
    }
    element.setAttribute("data-contrast-sample-hide", "");
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
    const range = ownerDocument.createRange();
    range.selectNodeContents(this);
    const rectangle = range.getBoundingClientRect();
    return [
        rectangle.left + window.scrollX,
        rectangle.top + window.scrollY,
        rectangle.width,
        rectangle.height,
    ];
}

// Called on the node hideSampledText was, as `this`.
export function showSampledText(this: Node): void {
    const element = (this.nodeType === 3 ? this.parentElement : this) as HTMLElement;
    element.removeAttribute("data-contrast-sample-hide");
    element.ownerDocument.getElementById("contrast-sample-hide-style")?.remove();
}
