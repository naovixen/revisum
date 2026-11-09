/// <reference lib="dom" />
// What a probe reads of one element.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// A snapshot of one element as JSON, in the shape of ElementProbe.
export function probeElement(element: Element, selectors: readonly string[]): string {
    const rectangle = Element.prototype.getBoundingClientRect.call(element);
    const style = getComputedStyle(element);
    const isVisible =
        rectangle.width > 0 &&
        rectangle.height > 0 &&
        style.visibility !== "hidden" &&
        style.display !== "none";
    const isField =
        element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement;
    const selectorList = selectors.join(",");
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
    const isInsideMatch = (): boolean => {
        for (let node: Element | null = element; node !== null; node = parentOf(node)) {
            if (Element.prototype.matches.call(node, selectorList)) {
                return true;
            }
        }
        return false;
    };
    const hasMatchInside = (): boolean => {
        const rootOf = (node: Element): ShadowRoot | null =>
            Reflect.get(Element.prototype, "shadowRoot", node);
        const elementRoot = rootOf(element);
        const scopes: (Element | ShadowRoot)[] =
            elementRoot === null ? [element] : [element, elementRoot];
        for (const scope of scopes) {
            const isElement = scope instanceof Element;
            const inScope = (selector: string): NodeListOf<Element> =>
                isElement
                    ? Element.prototype.querySelectorAll.call(scope, selector)
                    : scope.querySelectorAll(selector);
            if (inScope(selectorList).length > 0) {
                return true;
            }
            for (const inner of Array.from(inScope("*"))) {
                const innerRoot = rootOf(inner);
                if (innerRoot !== null) {
                    scopes.push(innerRoot);
                }
            }
        }
        return false;
    };
    const isSensitive = selectorList !== "" && (isInsideMatch() || hasMatchInside());
    return JSON.stringify({
        count: 1,
        visible: isVisible,
        // An SVG element has no innerText.
        text:
            element instanceof HTMLElement
                ? Reflect.get(HTMLElement.prototype, "innerText", element)
                : Reflect.get(Node.prototype, "textContent", element),
        value: isField ? (element as HTMLInputElement).value : null,
        sensitive: isSensitive,
        box: { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height },
    });
}

// What a probe reads besides the accessibility tree, as JSON: the absolute href of the link the
// element is, or is in (null outside a link), and its aria-current state. Any aria-current value but
// "false" (or empty) is current. With none, a link or a control is not current; any other element
// does not expose the state ("none").
export function linkAndCurrent(element: Element): string {
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
    while (link !== null && !Element.prototype.matches.call(link, "a[href], area[href]")) {
        link = parentOf(link);
    }
    const href =
        link instanceof HTMLAnchorElement || link instanceof HTMLAreaElement ? link.href : null;
    const controlRoles = [
        "link",
        "button",
        "tab",
        "menuitem",
        "menuitemcheckbox",
        "menuitemradio",
        "option",
        "treeitem",
        "gridcell",
        "row",
        "checkbox",
        "radio",
        "switch",
    ];
    const attributeOf = (name: string): string | null =>
        Element.prototype.getAttribute.call(element, name);
    const declared = attributeOf("aria-current");
    let current: string;
    if (declared !== null) {
        current =
            declared.trim() === "" || declared.trim().toLowerCase() === "false" ? "false" : "true";
    } else {
        const role = (attributeOf("role") ?? "").trim().split(/\s+/)[0] ?? "";
        const isControl =
            Element.prototype.matches.call(
                element,
                "a[href], area[href], button, input, select, textarea, summary, option",
            ) || controlRoles.includes(role);
        current = isControl ? "false" : "none";
    }
    return JSON.stringify({ href, current });
}

// One DOM read of the element, as JSON in the shape of DomValue: its class tokens, the computed
// value of the style property `name`, or the value of the attribute `name` (null when absent).
export function readDomValue(element: Element, kind: string, name: string): string {
    if (kind === "classes") {
        return JSON.stringify({
            kind,
            classes: Array.from(Reflect.get(Element.prototype, "classList", element)),
        });
    }
    if (kind === "computedStyle") {
        return JSON.stringify({ kind, value: getComputedStyle(element).getPropertyValue(name) });
    }
    return JSON.stringify({
        kind: "attribute",
        value: Element.prototype.getAttribute.call(element, name),
    });
}

// True when the element belongs to this document, not to a frame inside it.
export function inThisDocument(element: Element): string {
    return Reflect.get(Node.prototype, "ownerDocument", element) === document ? "yes" : "no";
}

// Called on an element, as `this`, so it runs in that element's own world and document.
export function isConnectedToItsDocument(this: Element): boolean {
    return Reflect.get(Node.prototype, "isConnected", this);
}
