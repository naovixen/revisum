// The Tab walk: presses Tab through the page and records the focus order, and, when asked,
// whether focus is visible and whether the focused element is covered at each step.
import { isPlainObject } from '@revisum/contracts';
import type { FocusOcclusion, PageDriver, PageSnapshot, TabWalk } from '../rules/Rule.ts';
import { blurHeldElement, holdFocusedElement, refocusHeldElement } from '../in-page/HoldFocusedElement.ts';
import { measureOcclusion } from '../in-page/MeasureOcclusion.ts';
import { inSequentialFocus } from '../rules/ActRuleMeta.ts';

// The measure runs in the page's own world, where the page can patch what it calls. An answer that
// makes no sense stops the walk, as a script that threw does. Leaving the element unmeasured would
// let the rule say nothing about it, and the page pass.
function decodeOcclusion(measured: unknown): FocusOcclusion {
  if (isPlainObject(measured)) {
    const { inView, hits, total } = measured;
    if (typeof inView === 'boolean' && typeof hits === 'number' && Number.isInteger(hits) && typeof total === 'number' && Number.isInteger(total)) {
      return { inView, hits, total };
    }
  }
  throw new Error('the page gave an unreadable measure of what covers the focused element');
}

export interface WalkOptions { focusVisibility: boolean; occlusion: boolean; stepLimit?: number }

export async function tabWalk(page: PageDriver, snapshot: PageSnapshot, options: WalkOptions): Promise<TabWalk> {
  const indexByBackend = new Map<number, number>();
  for (const node of snapshot.nodes) {if (node.nodeType === 1 && !indexByBackend.has(node.backendId)) {indexByBackend.set(node.backendId, node.index);}}
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
    if (active === null) { walk.endedAtDocument = true; break; }
    let index = indexByBackend.get(active.backendId) ?? seenBackend.get(active.backendId);
    if (index === undefined) {
      index = createdLater--;
      seenBackend.set(active.backendId, index);
    }
    walk.visits.push(index);
    if (walk.sequence.includes(index)) {continue;}
    walk.sequence.push(index);
    if (active.box !== null) {walk.boxes.set(index, active.box);}
    await page.evaluate(`(${holdFocusedElement.toString()})()`);
    if (options.occlusion) {
      walk.obscured.set(index, decodeOcclusion(await page.evaluate(`(${measureOcclusion.toString()})()`)));
    }
    if (options.focusVisibility) {
      const focused = await page.screenshot();
      await page.evaluate(`(${blurHeldElement.toString()})()`);
      const blurred = await page.screenshot();
      walk.focusVisible.set(index, focused !== blurred);
      await page.evaluate(`(${refocusHeldElement.toString()})()`);
    }
  }
  return walk;
}

// The repeating tail of the visit log when the walk never left the page: the trapped elements.
export function trapSet(walk: TabWalk): number[] {
  if (walk.endedAtDocument || walk.visits.length === 0) {return [];}
  const tail = walk.visits.slice(-Math.max(4, Math.floor(walk.visits.length / 2)));
  return [...new Set(tail)];
}
