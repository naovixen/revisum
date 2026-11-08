/// <reference lib="dom" />
// Whether the browser accepts a selector.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// 'valid' when the browser accepts the css selector or XPath expression, 'invalid' when it rejects
// it, or when the XPath expression gives no list of nodes (such as count()), so a locator holding
// it can never match anything.
export function structuralSelectorValidity(kind: string, text: string): string {
    try {
        if (kind === "css") {
            document.createDocumentFragment().querySelector(text);
        } else {
            document.evaluate(text, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
        }
        return "valid";
    } catch {
        return "invalid";
    }
}
