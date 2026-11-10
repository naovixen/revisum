// Self-contained page functions, as in the rest of this folder: each runs in the page, on its own.
// The nodes a press at the point passes through on its way down: what it hits, inside every open
// shadow root, and all that holds it, up to the document. `element` stands in when nothing is there.
// A form's named inputs hide what it inherits, so what may be a form is read through the prototypes.
export function nodesAPressPasses(element: Element, x: number, y: number): Node[] {
    const rootOf = (node: Element): ShadowRoot | null =>
        Reflect.get(Element.prototype, "shadowRoot", node);
    let hit = document.elementFromPoint(x, y);
    let inner = hit === null ? null : (rootOf(hit)?.elementFromPoint(x, y) ?? null);
    while (inner !== null && inner !== hit) {
        hit = inner;
        inner = rootOf(hit)?.elementFromPoint(x, y) ?? null;
    }
    const holderOf = (node: Node): Node | null => {
        if (node instanceof ShadowRoot) {
            return node.host;
        }
        const slot =
            node instanceof Element ? Reflect.get(Element.prototype, "assignedSlot", node) : null;
        return slot ?? Reflect.get(Node.prototype, "parentNode", node);
    };
    const passed: Node[] = [];
    for (let node: Node | null = hit ?? element; node !== null; node = holderOf(node)) {
        passed.push(node);
    }
    return passed;
}

// 'yes' when one of the nodes does something by itself when pressed, whatever the page's scripts do.
export function pressActsByItself(...nodes: Node[]): string {
    const actsByItself =
        'a[href], area[href], label, summary, input, select, textarea, button:not([type="button"])';
    return nodes.some(
        (node) => node instanceof Element && Element.prototype.matches.call(node, actsByItself),
    )
        ? "yes"
        : "no";
}
