/// <reference lib="dom" />
// What the runtime guard reads of an element.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// The control Enter in the element's form would submit it through, as a list of at most one so it
// comes back as a handle the browser's accessibility engine can be asked about.
export function formSubmitControl(element: Element): Element[] {
    const field = element as HTMLInputElement;
    const form =
        field.form instanceof HTMLFormElement
            ? field.form
            : Element.prototype.closest.call(element, "form");
    if (form === null) {
        return [];
    }
    const isSubmitOfForm = (control: Element): boolean => {
        if (control instanceof HTMLButtonElement) {
            return (
                Reflect.get(HTMLButtonElement.prototype, "form", control) === form &&
                Reflect.get(HTMLButtonElement.prototype, "type", control) === "submit"
            );
        }
        if (control instanceof HTMLInputElement) {
            const type: string = Reflect.get(HTMLInputElement.prototype, "type", control);
            return (
                Reflect.get(HTMLInputElement.prototype, "form", control) === form &&
                (type === "submit" || type === "image")
            );
        }
        return false;
    };
    // A form's `elements` leaves out image inputs, so its controls are found as the browser finds
    // them: anywhere in its root, since the `form` attribute can place a control outside the form.
    const controlsIn = (root: Node): NodeListOf<Element> => {
        const selector = "button, input";
        if (root instanceof Document) {
            return Document.prototype.querySelectorAll.call(root, selector);
        }
        if (root instanceof DocumentFragment) {
            return DocumentFragment.prototype.querySelectorAll.call(root, selector);
        }
        return Element.prototype.querySelectorAll.call(root as Element, selector);
    };
    const submit = Array.from(controlsIn(Node.prototype.getRootNode.call(form))).find(
        isSubmitOfForm,
    );
    return submit === undefined ? [] : [submit];
}

// What the policy gate's runtime guard needs to know about an element besides its role and name,
// as JSON: its box, the name its form's submit control `submit` carries in the page, the URL of the
// link it is in, and its own test id. A field the page does not show is null. The submit's name is
// for a control hidden from the accessibility engine, which Enter still submits through.
export function guardDetails(element: Element, submit?: Element): string {
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
    // An SVG link may carry its target in the older xlink:href, and an SVG link's href property is no
    // string, so the target is read from the attribute however the link is drawn.
    const targetOf = (node: Element): string | null =>
        Element.prototype.matches.call(node, "a, area")
            ? (Element.prototype.getAttribute.call(node, "href") ??
              Element.prototype.getAttributeNS.call(node, "http://www.w3.org/1999/xlink", "href"))
            : null;
    const resolvedUrl = (node: Element, target: string): string => {
        const base: string = Reflect.get(Node.prototype, "baseURI", node);
        try {
            return new URL(target, base).href;
        } catch {
            return target;
        }
    };
    let link: Element | null = element;
    while (link !== null && targetOf(link) === null) {
        link = parentOf(link);
    }
    const target = link === null ? null : targetOf(link);
    return JSON.stringify({
        box: { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height },
        formSubmitName: submitName === "" ? null : submitName,
        linkUrl: link === null || target === null ? null : resolvedUrl(link, target),
        testId: Element.prototype.getAttribute.call(element, "data-testid"),
    });
}
