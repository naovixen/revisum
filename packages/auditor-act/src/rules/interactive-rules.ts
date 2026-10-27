// Keyboard-driven ACT rules, and probes for success criteria that have no automatable ACT rule.
// ACT rules follow their W3C rule text; probes follow the WCAG 2.2 success criterion named in
// meta.source.
import type { Box } from '@revisum/contracts';
import type { InteractiveRule, PageDriver, PageSnapshot, SnapshotNode, TargetResult } from '../accessibility-types.ts';
import { snapshotExtras } from '../page-snapshot.ts';
import { ancestors, descendants, isVisible, parentElement } from '../snapshot-queries.ts';
import { trapSet } from '../tab-walk.ts';
import { actRuleMeta, actuallyDisabled, focusable, inSequentialFocus, probeMeta, tabIndexOf } from './rule-predicates.ts';

const WCAG_UNDERSTANDING = 'https://www.w3.org/TR/WCAG22/#';
const nodeAt = (snapshot: PageSnapshot, index: number): SnapshotNode | undefined => (index >= 0 ? snapshot.nodes[index] : undefined);
const result = (index: number, outcome: TargetResult['outcome'], message = ''): TargetResult => ({ node: index, outcome, message });

// True when focus leaves the page within `limit` presses of Tab (or Shift+Tab).
async function focusEscapes(page: PageDriver, shift: boolean, limit: number): Promise<boolean> {
  for (let i = 0; i < limit; i++) {
    await page.pressKey('Tab', shift);
    if (!(await page.activeElement())) return true;
  }
  return false;
}

// ACT a1b64e: focusable element has no keyboard trap via standard navigation.
export const keyboardTrapRule: InteractiveRule = {
  meta: actRuleMeta('a1b64e', 'Focusable element has no keyboard trap via standard navigation', ['2.1.2'], 'P1'),
  needsWalk: true,
  async run(page, snapshot, walk) {
    const targets = snapshot.nodes.filter((node) => focusable(snapshot, node));
    if (targets.length === 0 && walk.sequence.length === 0) return [];
    const limit = Math.max(12, walk.sequence.length * 2 + 6);
    const results = new Map<number, TargetResult>();
    const trapped = trapSet(walk);
    // The forward walk left the page, so every element it visited cycles back to the browser.
    for (const index of walk.sequence) if (!trapped.includes(index)) results.set(index, result(index, 'passed'));
    if (trapped.length) {
      // Standard keyboard navigation (ACT glossary) includes Tab, Shift+Tab and Escape: try Shift+Tab, then Escape and Tab.
      let escaped = await focusEscapes(page, true, limit);
      if (!escaped) {
        await page.pressKey('Escape');
        escaped = await focusEscapes(page, false, limit);
      }
      for (const index of trapped) {
        results.set(index, escaped ? result(index, 'passed') : result(index, 'failed', 'Keyboard focus cannot leave this element with Tab or Shift+Tab'));
      }
    }
    // Focusable elements the walk never reached (tabindex=-1, or behind a trap): focus each directly, then try both directions.
    let budget = 20;
    for (const node of targets) {
      if (results.has(node.index)) continue;
      if (budget-- <= 0) { results.set(node.index, result(node.index, 'cantTell', 'Not tested (budget)')); continue; }
      if (!(await page.focusBackend(node.backendId))) { results.set(node.index, result(node.index, 'passed', 'Cannot hold focus')); continue; }
      const escapes = (await focusEscapes(page, false, limit))
        || ((await page.focusBackend(node.backendId)) && (await focusEscapes(page, true, limit)));
      results.set(node.index, escapes ? result(node.index, 'passed') : result(node.index, 'failed', 'Keyboard focus cannot leave this element with Tab or Shift+Tab'));
    }
    return [...results.values()].filter((entry) => entry.node >= 0);
  },
};

// ACT oj04fd: element in sequential focus order has visible focus.
export const visibleFocusRule: InteractiveRule = {
  meta: actRuleMeta('oj04fd', 'Element in sequential focus order has visible focus', ['2.4.7'], 'P2'),
  needsWalk: true,
  async run(_page, snapshot, walk) {
    const results: TargetResult[] = [];
    for (const index of walk.sequence) {
      if (index < 0) continue;
      const visible = walk.focusVisible.get(index);
      if (visible === undefined) results.push(result(index, 'cantTell', 'Not measured'));
      else results.push(visible ? result(index, 'passed') : result(index, 'failed', 'No pixel in the viewport changes when this element receives focus'));
    }
    if (!walk.endedAtDocument) {
      for (const node of snapshot.nodes) {
        if (inSequentialFocus(snapshot, node) && !walk.sequence.includes(node.index)) results.push(result(node.index, 'cantTell', 'Not reached by the Tab walk'));
      }
    }
    return results;
  },
};

// WCAG 2.2 success criterion 2.4.11 Focus Not Obscured (Minimum).
export const focusNotObscuredProbe: InteractiveRule = {
  meta: probeMeta('keyboard-focus-obscured', 'Focused element is not entirely hidden by author content', ['2.4.11'], 'P2', WCAG_UNDERSTANDING + 'focus-not-obscured-minimum'),
  needsWalk: true,
  async run(_page, _snapshot, walk) {
    const results: TargetResult[] = [];
    for (const index of walk.sequence) {
      if (index < 0) continue;
      const occlusion = walk.obscured.get(index);
      if (!occlusion) continue;
      if (!occlusion.inView) results.push(result(index, 'cantTell', 'Focused element is outside the viewport'));
      else if (occlusion.hits === 0) results.push(result(index, 'failed', `Focused element is entirely covered by other content (0 of ${occlusion.total} sample points visible)`));
      else results.push(result(index, 'passed'));
    }
    return results;
  },
};

// WCAG 2.2 success criterion 2.4.3 Focus Order. It decides only reordering the author caused:
// a positive tabindex (WCAG failure technique F44) or CSS order and reversed flex direction (technique C27).
function onSameRow(first: Box, second: Box): boolean {
  const overlap = Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y);
  return overlap >= 0.5 * Math.min(first.height, second.height);
}
function reorderCause(snapshot: PageSnapshot, from: SnapshotNode, to: SnapshotNode): string | null {
  if ((tabIndexOf(from) ?? 0) > 0 || (tabIndexOf(to) ?? 0) > 0) return 'positive tabindex';
  const fromChain = [from, ...ancestors(snapshot, from)];
  const toChain = [to, ...ancestors(snapshot, to)];
  const toSet = new Set(toChain);
  const common = fromChain.find((node) => toSet.has(node));
  const chain = [
    ...fromChain.slice(0, common ? fromChain.indexOf(common) + 1 : fromChain.length),
    ...toChain.slice(0, common ? toChain.indexOf(common) : undefined),
  ];
  for (const node of chain) {
    if ((node.style?.['order'] ?? '0') !== '0') return 'CSS order';
    if ((node.style?.['flex-direction'] ?? '').endsWith('reverse') && /flex/.test(node.style?.['display'] ?? '')) return 'reversed flex direction';
  }
  return null;
}
export const focusOrderProbe: InteractiveRule = {
  meta: probeMeta('keyboard-focus-order', 'Focus order follows visual reading order', ['2.4.3'], 'P3', WCAG_UNDERSTANDING + 'focus-order'),
  needsWalk: true,
  async run(_page, snapshot, walk) {
    const results = new Map<number, TargetResult>();
    const sequence = walk.sequence.filter((index) => index >= 0);
    for (const index of sequence) results.set(index, result(index, 'passed'));
    const rightToLeft = (snapshot.nodes.find((node) => node.name === 'html')?.attributes['dir'] ?? '').toLowerCase() === 'rtl';
    for (let k = 1; k < sequence.length; k++) {
      const fromIndex = sequence[k - 1] as number;
      const toIndex = sequence[k] as number;
      const fromBox = walk.boxes.get(fromIndex);
      const toBox = walk.boxes.get(toIndex);
      const fromNode = nodeAt(snapshot, fromIndex);
      const toNode = nodeAt(snapshot, toIndex);
      if (!fromBox || !toBox || !fromNode || !toNode || fromBox.width < 1 || fromBox.height < 1 || toBox.width < 1 || toBox.height < 1) continue;
      const sameRow = onSameRow(fromBox, toBox);
      const backwards = sameRow
        ? (rightToLeft ? toBox.x >= fromBox.x + fromBox.width - 1 : toBox.x + toBox.width <= fromBox.x + 1)
        : toBox.y + toBox.height <= fromBox.y + 1;
      if (!backwards) continue;
      const cause = reorderCause(snapshot, fromNode, toNode);
      const message = `Focus moves from "${fromNode.accessibility?.name ?? fromNode.name}" back to "${toNode.accessibility?.name ?? toNode.name}", which is visually ${sameRow ? 'before it on the same line' : 'above it'}`;
      results.set(toIndex, cause ? result(toIndex, 'failed', `${message} (${cause})`) : result(toIndex, 'cantTell', message));
    }
    return [...results.values()];
  },
};

// WCAG 2.2 success criterion 2.1.1 Keyboard: elements Chromium reports as clickable (a click
// listener or native activation) that keyboard users cannot reach, with no focusable descendant or ancestor.
const NEVER_CHECKED_FOR_REACH = new Set(['html', 'body', 'label', 'option', 'optgroup', 'select', 'input', 'textarea', 'button', 'summary', 'area', 'iframe', 'video', 'audio']);
export const keyboardReachProbe: InteractiveRule = {
  meta: probeMeta('keyboard-reachable', 'Clickable element can be reached with the keyboard', ['2.1.1'], 'P1', WCAG_UNDERSTANDING + 'keyboard'),
  needsWalk: true,
  async run(_page, snapshot, walk) {
    const results: TargetResult[] = [];
    const clickable = snapshotExtras(snapshot).clickable;
    const visited = new Set(walk.sequence);
    for (const index of clickable) {
      const node = nodeAt(snapshot, index);
      if (!node || node.nodeType !== 1 || NEVER_CHECKED_FOR_REACH.has(node.name) || !isVisible(snapshot, node) || actuallyDisabled(snapshot, node)) continue;
      if (node.name === 'a' && node.attributes['href'] === undefined && !clickable.has(index)) continue;
      const nodeAncestors = ancestors(snapshot, node);
      if (nodeAncestors.some((ancestor) => ancestor.name === 'label' || ancestor.name === 'button' || ancestor.name === 'a' || ancestor.name === 'summary')) continue;
      const reachable = (candidate: SnapshotNode): boolean => inSequentialFocus(snapshot, candidate) || visited.has(candidate.index);
      if (reachable(node) || nodeAncestors.some(reachable) || descendants(snapshot, node).some((descendant) => descendant.nodeType === 1 && reachable(descendant))) {
        results.push(result(index, 'passed'));
        continue;
      }
      if (node.attributes['aria-hidden'] === 'true' || nodeAncestors.some((ancestor) => ancestor.attributes['aria-hidden'] === 'true')) continue;
      results.push(result(index, 'failed', `Clickable <${node.name}> cannot be reached with the Tab key`));
    }
    return results;
  },
};

// WCAG 2.2 success criterion 2.5.8 Target Size (Minimum): 24 by 24 CSS pixels, or spaced so that
// 24-pixel circles centred on the targets do not intersect.
const NATIVE_CONTROLS = new Set(['input', 'select', 'button', 'textarea', 'summary']);
export const targetSizeProbe: InteractiveRule = {
  meta: probeMeta('page-target-size', 'Pointer target is at least 24 by 24 CSS pixels or adequately spaced', ['2.5.8'], 'P3', WCAG_UNDERSTANDING + 'target-size-minimum'),
  needsWalk: true,
  async run(page, snapshot, walk) {
    const clickable = snapshotExtras(snapshot).clickable;
    const isTarget = (node: SnapshotNode): boolean => node.nodeType === 1 && !['html', 'body', 'label', 'option'].includes(node.name)
      && isVisible(snapshot, node) && node.bounds !== null
      && (inSequentialFocus(snapshot, node) || clickable.has(node.index) || walk.sequence.includes(node.index));
    const candidates = snapshot.nodes.filter(isTarget);
    const targets = candidates.filter((node) => !ancestors(snapshot, node).some((ancestor) => candidates.includes(ancestor)));
    const results: TargetResult[] = [];
    const undersized = new Set<SnapshotNode>();
    for (const target of targets) {
      const bounds = target.bounds as Box;
      if (bounds.width >= 24 && bounds.height >= 24) continue;
      undersized.add(target);
    }
    for (const target of targets) {
      if (!undersized.has(target)) { results.push(result(target.index, 'passed')); continue; }
      // The inline exception: the target sits in a line of text.
      const display = target.style?.['display'] ?? 'inline';
      if (display === 'inline') { results.push(result(target.index, 'passed', 'inline exception')); continue; }
      // The user-agent control exception: the browser sets the size and the author has not changed it.
      if (NATIVE_CONTROLS.has(target.name)) {
        const declared = await page.authorDeclaredProperties(target.backendId);
        const sizeChanged = declared.some((property) =>
          /^(width|height|min-width|min-height|max-width|max-height|inline-size|block-size|padding|font-size|font|line-height|zoom|transform|border)/.test(property));
        if (!sizeChanged) { results.push(result(target.index, 'passed', 'user-agent control exception')); continue; }
      }
      const bounds = target.bounds as Box;
      const centre = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
      const clash = targets.find((other) => {
        if (other === target) return false;
        const otherBounds = other.bounds as Box;
        if (undersized.has(other)) {
          const otherCentre = { x: otherBounds.x + otherBounds.width / 2, y: otherBounds.y + otherBounds.height / 2 };
          return Math.hypot(otherCentre.x - centre.x, otherCentre.y - centre.y) < 24;
        }
        const distanceX = Math.max(otherBounds.x - centre.x, 0, centre.x - (otherBounds.x + otherBounds.width));
        const distanceY = Math.max(otherBounds.y - centre.y, 0, centre.y - (otherBounds.y + otherBounds.height));
        return Math.hypot(distanceX, distanceY) < 12;
      });
      if (clash) results.push(result(target.index, 'failed', `Target is ${Math.round(bounds.width)} x ${Math.round(bounds.height)} CSS px and too close to another target`));
      else results.push(result(target.index, 'passed', 'spacing exception'));
    }
    return results;
  },
};

// WCAG 2.2 success criterion 1.4.10 Reflow: at 320 CSS pixels wide, content must not need
// horizontal scrolling, except parts that need two-dimensional layout (left as cantTell).
const TWO_DIMENSIONAL = new Set(['table', 'pre', 'code', 'img', 'video', 'canvas', 'svg', 'iframe', 'map', 'math', 'object', 'embed']);
export const reflowProbe: InteractiveRule = {
  meta: probeMeta('page-reflow', 'Content reflows at 320 CSS px without horizontal scrolling', ['1.4.10'], 'P2', WCAG_UNDERSTANDING + 'reflow'),
  needsWalk: false,
  async run(page, snapshot) {
    const root = snapshot.nodes.find((node) => node.nodeType === 1 && node.name === 'html' && node.document === 0);
    if (!root) return [];
    await page.setViewport(320, 256);
    try {
      await page.evaluate(`new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30))))`);
      const widths = await page.evaluate<{ scrollWidth: number; clientWidth: number }>(
        `({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })`);
      if (widths.scrollWidth <= widths.clientWidth + 1) return [result(root.index, 'passed')];
      const narrow = await page.snapshot();
      const indexByBackend = new Map(snapshot.nodes.map((node) => [node.backendId, node.index]));
      const overflows = (node: SnapshotNode): boolean => node.bounds !== null && node.bounds.width > 0
        && node.bounds.x + node.bounds.width > widths.clientWidth + 1 && node.document === 0;
      const offenders = narrow.nodes.filter((node) => {
        if (node.nodeType !== 1 || node.name === 'html' || node.name === 'body' || !overflows(node) || node.style?.['position'] === 'fixed') return false;
        const parent = parentElement(narrow, node);
        return !(parent && overflows(parent) && !['html', 'body'].includes(parent.name));
      });
      if (offenders.length === 0) return [result(root.index, 'cantTell', `Page is ${widths.scrollWidth} px wide at a 320 px viewport`)];
      return offenders.slice(0, 5).map((offender) => {
        const index = indexByBackend.get(offender.backendId) ?? root.index;
        const twoDimensional = TWO_DIMENSIONAL.has(offender.name) || ancestors(narrow, offender).some((ancestor) => TWO_DIMENSIONAL.has(ancestor.name));
        const message = `<${offender.name}> is ${Math.round((offender.bounds as Box).width)} px wide; at 320 px the page needs horizontal scrolling`;
        return result(index, twoDimensional ? 'cantTell' : 'failed', twoDimensional ? message + ' (may be exempt: two-dimensional content)' : message);
      });
    } finally {
      await page.setViewport(snapshot.viewport.width || 1024, snapshot.viewport.height || 768);
    }
  },
};

export const INTERACTIVE_RULES: InteractiveRule[] = [
  keyboardTrapRule, visibleFocusRule, focusNotObscuredProbe, focusOrderProbe, keyboardReachProbe, targetSizeProbe, reflowProbe,
];
