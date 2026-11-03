// Self-contained page functions, as in in-page.ts: each runs in the page, on its own.
// The nodes a press at the point passes through on its way down: what it hits, inside every open
// shadow root, and all that holds it, up to the document. `element` stands in when nothing is there.
export function nodesAPressPasses(element: Element, x: number, y: number): Node[] {
  let hit = document.elementFromPoint(x, y);
  let inner = hit?.shadowRoot?.elementFromPoint(x, y) ?? null;
  while (inner !== null && inner !== hit) {
    hit = inner;
    inner = hit.shadowRoot?.elementFromPoint(x, y) ?? null;
  }
  const holderOf = (node: Node): Node | null => {
    if (node instanceof ShadowRoot) {
      return node.host;
    }
    return (node instanceof Element ? node.assignedSlot : null) ?? node.parentNode;
  };
  const passed: Node[] = [];
  for (let node: Node | null = hit ?? element; node !== null; node = holderOf(node)) {
    passed.push(node);
  }
  return passed;
}

// 'yes' when one of the nodes does something by itself when pressed, whatever the page's scripts do.
export function pressActsByItself(...nodes: Node[]): string {
  const actsByItself = 'a[href], area[href], label, summary, input, select, textarea, button:not([type="button"])';
  return nodes.some((node) => node instanceof Element && node.matches(actsByItself)) ? 'yes' : 'no';
}
