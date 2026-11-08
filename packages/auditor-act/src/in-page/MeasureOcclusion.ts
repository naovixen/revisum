/// <reference lib="dom" />
// How much of the held focused element is on top. It runs inside the page and is sent with
// toString(), so it is self-contained: no imports and no closures over Node values.

type WindowHoldingFocus = Window & { __focusedElement?: Element | null };

type OcclusionInPage = { readonly inView: boolean; readonly hits: number; readonly total: number };

// Samples a 5 by 5 grid over the held element and counts the points where it is on top.
export function measureOcclusion(): OcclusionInPage {
    const element = (window as WindowHoldingFocus).__focusedElement;
    if (
        element === null ||
        element === undefined ||
        typeof element.getBoundingClientRect !== "function"
    ) {
        return { inView: false, hits: 0, total: 0 };
    }
    const ownerDocument = element.ownerDocument;
    const view = ownerDocument.defaultView as Window;
    const rectangle = element.getBoundingClientRect();
    const left = Math.max(rectangle.left, 0);
    const right = Math.min(rectangle.right, view.innerWidth);
    const top = Math.max(rectangle.top, 0);
    const bottom = Math.min(rectangle.bottom, view.innerHeight);
    if (right - left < 1 || bottom - top < 1) {
        return { inView: false, hits: 0, total: 0 };
    }
    const parentOf = (node: Node): Node | undefined =>
        node.parentNode ?? (node as ShadowRoot).host;
    const isInside = (hit: Element): boolean => {
        let node: Node | undefined = hit;
        while (node !== undefined) {
            if (node === element) {
                return true;
            }
            node = parentOf(node);
        }
        return false;
    };
    let hits = 0;
    let total = 0;
    for (let column = 0; column < 5; column++) {
        for (let row = 0; row < 5; row++) {
            const x = left + ((right - left) * (column + 0.5)) / 5;
            const y = top + ((bottom - top) * (row + 0.5)) / 5;
            let hit: Element | null = ownerDocument.elementFromPoint(x, y);
            while (hit !== null && hit.shadowRoot !== null) {
                const inner: Element | null = hit.shadowRoot.elementFromPoint(x, y);
                if (inner === null || inner === hit) {
                    break;
                }
                hit = inner;
            }
            total++;
            if (hit !== null && isInside(hit)) {
                hits++;
            }
        }
    }
    return { inView: true, hits, total };
}
