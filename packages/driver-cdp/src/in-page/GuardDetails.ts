/// <reference lib="dom" />
// What the runtime guard reads of an element.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// What the policy gate's runtime guard needs to know about an element besides its role and name,
// as JSON: its box, the accessible name of its form's submit control, the URL of the link it is
// in, and its own test id. A field the page does not show is null.
export function guardDetails(element: Element): string {
    const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();
    const nameOf = (control: Element): string => {
        const ariaLabel = Element.prototype.getAttribute.call(control, "aria-label");
        if (ariaLabel !== null && normalise(ariaLabel) !== "") {
            return normalise(ariaLabel);
        }
        const labelledBy = Element.prototype.getAttribute.call(control, "aria-labelledby");
        if (labelledBy !== null) {
            const root = Node.prototype.getRootNode.call(control) as Document | ShadowRoot;
            const textOfId = (id: string): string => {
                const labelling = root.getElementById(id);
                return labelling === null
                    ? ""
                    : (Reflect.get(Node.prototype, "textContent", labelling) as string);
            };
            const text = normalise(labelledBy.split(/\s+/).map(textOfId).join(" "));
            if (text !== "") {
                return text;
            }
        }
        if (control instanceof HTMLInputElement && control.type === "image") {
            return normalise(control.alt);
        }
        if (control instanceof HTMLInputElement) {
            return normalise(control.value === "" ? "Submit" : control.value);
        }
        // An SVG element has no innerText.
        return normalise(
            (control instanceof HTMLElement
                ? Reflect.get(HTMLElement.prototype, "innerText", control)
                : Reflect.get(Node.prototype, "textContent", control)) as string,
        );
    };
    const rectangle = Element.prototype.getBoundingClientRect.call(element);
    const field = element as HTMLInputElement;
    const form =
        field.form instanceof HTMLFormElement
            ? field.form
            : Element.prototype.closest.call(element, "form");
    const controlsOf = (owner: Element): HTMLFormControlsCollection =>
        Reflect.get(HTMLFormElement.prototype, "elements", owner);
    const submit =
        form === null
            ? undefined
            : Array.from(controlsOf(form)).find(
                  (control) =>
                      (control instanceof HTMLButtonElement && control.type === "submit") ||
                      (control instanceof HTMLInputElement &&
                          (control.type === "submit" || control.type === "image")),
              );
    const submitName = submit === undefined ? "" : nameOf(submit);
    const parentOf = (node: Element): Element | null => {
        const slot = Reflect.get(Element.prototype, "assignedSlot", node);
        if (slot !== null) {
            return slot;
        }
        const parent = Reflect.get(Node.prototype, "parentElement", node);
        if (parent !== null) {
            return parent;
        }
        const root = Node.prototype.getRootNode.call(node);
        return root instanceof ShadowRoot ? root.host : null;
    };
    let link: Element | null = element;
    while (link !== null && !Element.prototype.matches.call(link, "a[href]")) {
        link = parentOf(link);
    }
    return JSON.stringify({
        box: { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height },
        formSubmitName: submitName === "" ? null : submitName,
        linkUrl: link instanceof HTMLAnchorElement ? link.href : null,
        testId: Element.prototype.getAttribute.call(element, "data-testid"),
    });
}
