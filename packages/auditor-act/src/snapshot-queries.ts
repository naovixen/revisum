// Snapshot helpers shared by the rules: tree walking, visibility, hidden state, selectors and colour.
import type { Box } from '@revisum/contracts';
import type { PageSnapshot, SnapshotNode } from './accessibility-types.ts';
import { snapshotExtras } from './page-snapshot.ts';

export function parentElement(snapshot: PageSnapshot, node: SnapshotNode): SnapshotNode | undefined {
  let parent = snapshot.nodes[node.parent];
  while (parent && parent.nodeType !== 1) {
    if (parent.nodeType === 9 && parent.parent < 0) return undefined;
    parent = snapshot.nodes[parent.parent];
  }
  return parent;
}

export function ancestors(snapshot: PageSnapshot, node: SnapshotNode): SnapshotNode[] {
  const found: SnapshotNode[] = [];
  let parent = parentElement(snapshot, node);
  while (parent) {
    found.push(parent);
    parent = parentElement(snapshot, parent);
  }
  return found;
}

export function descendants(snapshot: PageSnapshot, node: SnapshotNode, found: SnapshotNode[] = []): SnapshotNode[] {
  for (const childIndex of node.children) {
    const child = snapshot.nodes[childIndex];
    if (!child) continue;
    found.push(child);
    descendants(snapshot, child, found);
  }
  return found;
}

// True for an element inside an SVG element. Snapshot names are lower-cased; SVG children keep their own names.
export function inSvg(snapshot: PageSnapshot, node: SnapshotNode): boolean {
  return ancestors(snapshot, node).some((ancestor) => ancestor.name === 'svg');
}

// ACT "programmatically hidden": hidden through CSS display or visibility, or aria-hidden, on itself or an ancestor.
export function programmaticallyHidden(snapshot: PageSnapshot, node: SnapshotNode): boolean {
  if (node.attributes['aria-hidden'] === 'true') return true;
  for (const ancestor of ancestors(snapshot, node)) if (ancestor.attributes['aria-hidden'] === 'true') return true;
  if (!node.style) return true; // not rendered: display:none, or inside it
  if (node.style['visibility'] === 'hidden' || node.style['visibility'] === 'collapse') return true;
  return false;
}

// Included in the accessibility tree: Chromium has a non-ignored accessibility node for it.
export function inAccessibilityTree(node: SnapshotNode): boolean {
  return node.accessibility !== null && !node.accessibility.ignored;
}

export function parseColour(text: string | undefined): [number, number, number, number] | null {
  if (!text) return null;
  const match = text.match(/rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)/);
  if (!match) return null;
  let alpha = 1;
  if (match[4] !== undefined) alpha = match[4].endsWith('%') ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]);
  return [Number(match[1]), Number(match[2]), Number(match[3]), alpha];
}

// ACT "visible": renders at least one pixel on screen, approximated from layout and style.
export function isVisible(snapshot: PageSnapshot, node: SnapshotNode): boolean {
  const style = node.style;
  if (!style || !node.bounds) return false;
  if (style['visibility'] !== 'visible') return false;
  if (node.bounds.width < 1 || node.bounds.height < 1) return false;
  for (const ancestor of [node, ...ancestors(snapshot, node)]) {
    const ancestorStyle = ancestor.style;
    if (!ancestorStyle) return false;
    if (Number(ancestorStyle['opacity'] ?? '1') === 0) return false;
    const clip = ancestorStyle['clip'] ?? 'auto';
    if (ancestorStyle['position'] === 'absolute' && /rect\(\s*0(px)?[ ,]+0(px)?[ ,]+0(px)?[ ,]+0(px)?\s*\)/.test(clip)) return false;
    if ((ancestorStyle['clip-path'] ?? 'none').startsWith('inset(50%')) return false;
  }
  const bounds = node.bounds;
  if (bounds.x + bounds.width <= 0 || bounds.y + bounds.height <= 0) return false; // moved off screen to the left or top
  return true;
}

function isVisibleIgnoringSize(snapshot: PageSnapshot, node: SnapshotNode): boolean {
  return node.style !== null && node.style['visibility'] === 'visible'
    && ancestors(snapshot, node).every((ancestor) => ancestor.style !== null && Number(ancestor.style['opacity'] ?? '1') > 0);
}

export function textVisible(snapshot: PageSnapshot, text: SnapshotNode): boolean {
  if (text.nodeType !== 3 || text.value.trim() === '') return false;
  const parent = parentElement(snapshot, text);
  if (!parent || !parent.style || !text.bounds || text.bounds.width < 1) return false;
  if (!isVisible(snapshot, parent) && !(parent.bounds && parent.bounds.width < 1 && isVisibleIgnoringSize(snapshot, parent))) return false;
  const colour = parseColour(parent.style['color']);
  if (colour && colour[3] === 0) return false;
  return true;
}

function cssEscapeIdentifier(value: string): string {
  return value.replace(/([^a-zA-Z0-9_-])/g, '\\$1').replace(/^(\d)/, '\\3$1 ');
}

// The host of the shadow tree that contains the node, found from the flat tree.
function shadowHostOf(snapshot: PageSnapshot, node: SnapshotNode): SnapshotNode | undefined {
  const inShadow = snapshotExtras(snapshot).inShadow;
  let current: SnapshotNode | undefined = node;
  while (current && inShadow.has(current.index)) {
    const parent: SnapshotNode | undefined = snapshot.nodes[current.parent];
    if (!parent) return undefined;
    if (!inShadow.has(parent.index)) return parent;
    current = parent;
  }
  return undefined;
}

// The DOM parent of an element, undoing slot assignment in the flat tree.
function domParent(snapshot: PageSnapshot, node: SnapshotNode): SnapshotNode | undefined {
  const inShadow = snapshotExtras(snapshot).inShadow;
  const parent = snapshot.nodes[node.parent];
  if (!parent) return undefined;
  if (!inShadow.has(node.index) && inShadow.has(parent.index)) {
    // A slotted light-tree node: its DOM parent is the nearest light-tree ancestor.
    let current: SnapshotNode | undefined = parent;
    while (current && inShadow.has(current.index)) current = snapshot.nodes[current.parent];
    return current;
  }
  return parent;
}

// A selector chain: one selector per scope (the document, then each iframe document or shadow root).
export function selectorFor(snapshot: PageSnapshot, node: SnapshotNode): string[] {
  const inShadow = snapshotExtras(snapshot).inShadow;
  const chain: string[] = [];
  let scopeStart: SnapshotNode | undefined = node;
  while (scopeStart) {
    const parts: string[] = [];
    let current: SnapshotNode | undefined = scopeStart;
    let nextScope: SnapshotNode | undefined;
    while (current && current.nodeType === 1) {
      const element: SnapshotNode = current;
      const elementInShadow = inShadow.has(element.index);
      const id = element.attributes['id'];
      const uniqueId = id && snapshot.nodes.filter((other) => other.nodeType === 1 && other.document === element.document
        && inShadow.has(other.index) === elementInShadow && other.attributes['id'] === id).length === 1;
      if (id && uniqueId) {
        parts.unshift('#' + cssEscapeIdentifier(id));
        if (elementInShadow) nextScope = shadowHostOf(snapshot, element);
        else {
          let documentNode: SnapshotNode | undefined = element;
          while (documentNode && documentNode.nodeType !== 9) documentNode = snapshot.nodes[documentNode.parent];
          nextScope = documentNode && documentNode.parent >= 0 ? snapshot.nodes[documentNode.parent] : undefined;
        }
        break;
      }
      const parent = domParent(snapshot, element);
      const crossesShadowBoundary = elementInShadow && parent !== undefined && !inShadow.has(parent.index);
      if (!parent || parent.nodeType !== 1) {
        parts.unshift(element.name);
        nextScope = parent && parent.nodeType === 9 && parent.parent >= 0 ? snapshot.nodes[parent.parent] : undefined;
        break;
      }
      const siblings = snapshot.nodes.filter((other) => other.nodeType === 1 && inShadow.has(other.index) === elementInShadow
        && other.document === element.document && domParent(snapshot, other) === parent);
      parts.unshift(`${element.name}:nth-child(${siblings.indexOf(element) + 1})`);
      if (crossesShadowBoundary) { nextScope = parent; break; }
      current = parent;
    }
    chain.unshift(parts.join(' > '));
    scopeStart = nextScope;
  }
  return chain;
}

// The node's box, or the nearest ancestor's when the node has no area.
export function boxOf(snapshot: PageSnapshot, node: SnapshotNode): Box {
  let current: SnapshotNode | undefined = node;
  while (current) {
    if (current.bounds && (current.bounds.width > 0 || current.bounds.height > 0)) return current.bounds;
    current = snapshot.nodes[current.parent];
  }
  return { x: 0, y: 0, width: 0, height: 0 };
}

// The explicit role: the first token of the role attribute.
export function explicitRole(node: SnapshotNode): string | null {
  const role = node.attributes['role'];
  if (role === undefined) return null;
  const first = role.trim().toLowerCase().split(/\s+/)[0];
  return first ? first : null;
}
