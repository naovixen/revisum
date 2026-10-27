// The Tab walk: presses Tab through the page and records the focus order, and, when asked,
// whether focus is visible and whether the focused element is covered at each step.
import type { PageDriver, PageSnapshot, TabWalk } from './accessibility-types.ts';
import { inSequentialFocus } from './rules/rule-predicates.ts';

// Keeps a handle on the deepest focused element, through shadow roots and same-origin frames.
const HOLD_FOCUSED_ELEMENT = `(() => {
  let element = document.activeElement;
  for (;;) {
    if (!element) break;
    if (element.shadowRoot && element.shadowRoot.activeElement) { element = element.shadowRoot.activeElement; continue; }
    if ((element.tagName === 'IFRAME' || element.tagName === 'FRAME') && element.contentDocument && element.contentDocument.activeElement
      && element.contentDocument.activeElement !== element.contentDocument.body) { element = element.contentDocument.activeElement; continue; }
    break;
  }
  window.__focusedElement = element;
  return !!element;
})()`;

// Samples a 5 by 5 grid over the held element and counts the points where it is on top.
const MEASURE_OCCLUSION = `(() => {
  const element = window.__focusedElement;
  if (!element || !element.getBoundingClientRect) return { inView: false, hits: 0, total: 0 };
  const ownerDocument = element.ownerDocument, view = ownerDocument.defaultView;
  const rectangle = element.getBoundingClientRect();
  const left = Math.max(rectangle.left, 0), right = Math.min(rectangle.right, view.innerWidth);
  const top = Math.max(rectangle.top, 0), bottom = Math.min(rectangle.bottom, view.innerHeight);
  if (right - left < 1 || bottom - top < 1) return { inView: false, hits: 0, total: 0 };
  const inside = (hit) => { for (let node = hit; node; node = node.parentNode || node.host) { if (node === element) return true; } return false; };
  let hits = 0, total = 0;
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    const x = left + (right - left) * (i + 0.5) / 5, y = top + (bottom - top) * (j + 0.5) / 5;
    let hit = ownerDocument.elementFromPoint(x, y);
    while (hit && hit.shadowRoot) { const inner = hit.shadowRoot.elementFromPoint(x, y); if (!inner || inner === hit) break; hit = inner; }
    total++; if (hit && inside(hit)) hits++;
  }
  return { inView: true, hits, total };
})()`;

const BLUR_HELD_ELEMENT = `(() => { const element = window.__focusedElement; if (element && element.blur) element.blur(); })()`;
const REFOCUS_HELD_ELEMENT = `(() => { const element = window.__focusedElement; if (element && element.focus) element.focus({ preventScroll: true }); })()`;

export interface WalkOptions { focusVisibility: boolean; occlusion: boolean; stepLimit?: number }

export async function tabWalk(page: PageDriver, snapshot: PageSnapshot, options: WalkOptions): Promise<TabWalk> {
  const indexByBackend = new Map<number, number>();
  for (const node of snapshot.nodes) if (node.nodeType === 1 && !indexByBackend.has(node.backendId)) indexByBackend.set(node.backendId, node.index);
  const expected = snapshot.nodes.filter((node) => inSequentialFocus(snapshot, node)).length;
  const stepLimit = options.stepLimit ?? Math.min(150, Math.max(12, expected * 2 + 6));
  const walk: TabWalk = {
    sequence: [], visits: [], endedAtDocument: false, steps: 0,
    boxes: new Map(), viewportBoxes: new Map(), focusVisible: new Map(), obscured: new Map(),
  };
  let createdLater = -1; // elements created after the snapshot get negative indexes
  const seenBackend = new Map<number, number>();
  for (let step = 0; step < stepLimit; step++) {
    await page.pressKey('Tab');
    walk.steps++;
    const active = await page.activeElement();
    if (!active) { walk.endedAtDocument = true; break; }
    let index = indexByBackend.get(active.backendId) ?? seenBackend.get(active.backendId);
    if (index === undefined) {
      index = createdLater--;
      seenBackend.set(active.backendId, index);
    }
    walk.visits.push(index);
    if (walk.sequence.includes(index)) continue;
    walk.sequence.push(index);
    if (active.box) walk.boxes.set(index, active.box);
    await page.evaluate(HOLD_FOCUSED_ELEMENT);
    if (options.occlusion) walk.obscured.set(index, await page.evaluate<{ inView: boolean; hits: number; total: number }>(MEASURE_OCCLUSION));
    if (options.focusVisibility) {
      const focused = await page.screenshot();
      await page.evaluate(BLUR_HELD_ELEMENT);
      const blurred = await page.screenshot();
      walk.focusVisible.set(index, focused !== blurred);
      await page.evaluate(REFOCUS_HELD_ELEMENT);
    }
  }
  return walk;
}

// The repeating tail of the visit log when the walk never left the page: the trapped elements.
export function trapSet(walk: TabWalk): number[] {
  if (walk.endedAtDocument || walk.visits.length === 0) return [];
  const tail = walk.visits.slice(-Math.max(4, Math.floor(walk.visits.length / 2)));
  return [...new Set(tail)];
}
