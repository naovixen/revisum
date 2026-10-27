// The page snapshot: DOM, computed styles and layout (CDP DOMSnapshot) joined with Chromium's
// full accessibility tree, plus the extra facts some rules need.
import type { Box } from '@revisum/contracts';
import type { CdpSessionClient } from '@revisum/driver-cdp';
import type { AccessibilityInfo, PageSnapshot, SnapshotNode } from './accessibility-types.ts';

export const SNAPSHOT_STYLES = [
  'display', 'visibility', 'opacity', 'color', 'background-color', 'background-image', 'font-size', 'font-weight',
  'letter-spacing', 'word-spacing', 'line-height', 'overflow-x', 'overflow-y', 'position', 'clip', 'clip-path',
  'outline-style', 'outline-width', 'cursor', 'transform', 'text-shadow', 'content-visibility', 'order',
  'flex-direction', 'white-space', 'pointer-events', 'text-indent', 'width', 'height', 'z-index', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom',
  'text-overflow', 'border-top-style', 'border-top-width',
] as const;

// Chrome DevTools Protocol shapes the snapshot reads. Rare values come as parallel index and value lists.
interface RareValues<Value> { index: number[]; value: Value[] }
interface DocumentSnapshot {
  documentURL: number; frameId: number; scrollOffsetX?: number; scrollOffsetY?: number;
  nodes: {
    parentIndex: number[]; nodeType: number[]; nodeName: number[]; nodeValue: number[]; backendNodeId: number[];
    attributes: number[][]; shadowRootType?: RareValues<number>; contentDocumentIndex?: RareValues<number>;
    isClickable?: { index: number[] }; inputValue?: RareValues<number>; pseudoType?: RareValues<number>;
  };
  layout: {
    nodeIndex: number[]; styles: number[][]; bounds: number[][]; blendedBackgroundColors?: number[];
    textColorOpacities?: number[]; scrollRects?: number[][]; clientRects?: number[][];
  };
}
interface CapturedSnapshot { documents: DocumentSnapshot[]; strings: string[] }
interface AccessibilityValue { type: string; value?: unknown }
interface AccessibilityNode {
  nodeId: string; parentId?: string; childIds?: string[]; ignored: boolean; role?: AccessibilityValue; name?: AccessibilityValue;
  properties?: { name: string; value: AccessibilityValue }[]; backendDOMNodeId?: number;
}
interface FrameTree { frame: { id: string }; childFrames?: FrameTree[] }

export interface SnapshotExtras {
  // Node indexes Chromium reports as clickable: a click listener or native activation.
  clickable: Set<number>;
  // Node index to blended background colour (text nodes).
  blendedBackground: Map<number, string>;
  // Node index to text colour opacity (text nodes).
  textOpacity: Map<number, number>;
  // Node index to pseudo-element type.
  pseudoElement: Map<number, string>;
  // Node index to [scrollWidth, scrollHeight, clientWidth, clientHeight].
  scroll: Map<number, [number, number, number, number]>;
  // Nodes inside a shadow tree (DOMSnapshot returns the flat tree).
  inShadow: Set<number>;
  // Node index to the elements it owns in the accessibility tree (ignored nodes flattened), as node indexes.
  owned: Map<number, number[]>;
  frameIds: string[];
  contentType: string;
}

const extrasBySnapshot = new WeakMap<PageSnapshot, SnapshotExtras>();
export function snapshotExtras(snapshot: PageSnapshot): SnapshotExtras {
  const extras = extrasBySnapshot.get(snapshot);
  if (!extras) throw new Error('snapshot without extras');
  return extras;
}

function collectFrameIds(tree: FrameTree, found: string[] = []): string[] {
  found.push(tree.frame.id);
  for (const child of tree.childFrames ?? []) collectFrameIds(child, found);
  return found;
}

export async function buildSnapshot(session: CdpSessionClient): Promise<PageSnapshot> {
  const captured = await session.send<CapturedSnapshot>('DOMSnapshot.captureSnapshot', {
    computedStyles: [...SNAPSHOT_STYLES], includeDOMRects: true, includeBlendedBackgroundColors: true, includeTextColorOpacities: true,
  }, 30_000);
  const stringAt = (index: number | undefined): string => (index === undefined || index < 0 ? '' : captured.strings[index] ?? '');
  const { frameTree } = await session.send<{ frameTree: FrameTree }>('Page.getFrameTree');
  const frameIds = collectFrameIds(frameTree);
  const accessibility = new Map<number, AccessibilityInfo>();
  const ownedByBackend = new Map<number, number[]>();
  for (const frameId of frameIds) {
    let accessibilityNodes: AccessibilityNode[] = [];
    try {
      const parameters = frameId === frameTree.frame.id ? {} : { frameId };
      accessibilityNodes = (await session.send<{ nodes: AccessibilityNode[] }>('Accessibility.getFullAXTree', parameters, 30_000)).nodes;
    } catch { continue; } // cross-origin frames are out of scope
    const byId = new Map(accessibilityNodes.map((node) => [node.nodeId, node]));
    const ownedOf = (node: AccessibilityNode, owned: number[]): number[] => {
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (!child) continue;
        if (child.ignored || child.backendDOMNodeId === undefined) ownedOf(child, owned);
        else owned.push(child.backendDOMNodeId);
      }
      return owned;
    };
    for (const node of accessibilityNodes) {
      if (node.backendDOMNodeId !== undefined && !node.ignored && !ownedByBackend.has(node.backendDOMNodeId)) {
        ownedByBackend.set(node.backendDOMNodeId, ownedOf(node, []));
      }
    }
    for (const node of accessibilityNodes) {
      if (node.backendDOMNodeId === undefined) continue;
      const earlier = accessibility.get(node.backendDOMNodeId);
      if (earlier && !earlier.ignored) continue;
      const properties: Record<string, string | boolean | number> = {};
      for (const property of node.properties ?? []) {
        const value = property.value.value;
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') properties[property.name] = value;
      }
      accessibility.set(node.backendDOMNodeId, {
        role: String(node.role?.value ?? ''), name: String(node.name?.value ?? ''), ignored: node.ignored,
        focusable: properties['focusable'] === true, properties,
      });
    }
  }

  const nodes: SnapshotNode[] = [];
  const offsets: number[] = [];
  const extras: SnapshotExtras = {
    clickable: new Set(), blendedBackground: new Map(), textOpacity: new Map(), pseudoElement: new Map(), scroll: new Map(),
    owned: new Map(), inShadow: new Set(), frameIds, contentType: '',
  };
  const indexByBackend = new Map<number, number>();
  captured.documents.forEach((documentSnapshot, documentIndex) => {
    const offset = nodes.length;
    offsets.push(offset);
    const documentNodes = documentSnapshot.nodes;
    const count = documentNodes.parentIndex.length;
    for (let i = 0; i < count; i++) {
      const attributes: Record<string, string> = {};
      const attributePairs = documentNodes.attributes[i] ?? [];
      for (let k = 0; k + 1 < attributePairs.length; k += 2) attributes[stringAt(attributePairs[k]).toLowerCase()] = stringAt(attributePairs[k + 1]);
      const nodeType = documentNodes.nodeType[i] ?? 0;
      const parentIndex = documentNodes.parentIndex[i] ?? -1;
      nodes.push({
        index: offset + i, backendId: documentNodes.backendNodeId[i] ?? 0, nodeType, name: stringAt(documentNodes.nodeName[i]).toLowerCase(),
        value: stringAt(documentNodes.nodeValue[i]), attributes, parent: parentIndex < 0 ? -1 : offset + parentIndex, children: [],
        document: documentIndex, shadowHost: -1, contentDocument: -1, style: null, bounds: null, accessibility: null,
      });
    }
    for (const i of documentNodes.shadowRootType?.index ?? []) extras.inShadow.add(offset + i);
    for (const i of documentNodes.shadowRootType?.index ?? []) {
      const node = nodes[offset + i];
      // The top node of a shadow tree: its flat-tree parent is the shadow host.
      if (node && node.parent >= 0 && !extras.inShadow.has(node.parent)) node.shadowHost = node.parent;
    }
    for (const i of documentNodes.isClickable?.index ?? []) extras.clickable.add(offset + i);
    (documentNodes.pseudoType?.index ?? []).forEach((i, k) => extras.pseudoElement.set(offset + i, stringAt(documentNodes.pseudoType?.value[k])));
    const layout = documentSnapshot.layout;
    layout.nodeIndex.forEach((nodeIndex, k) => {
      const node = nodes[offset + nodeIndex];
      if (!node) return;
      const style: Record<string, string> = {};
      (layout.styles[k] ?? []).forEach((stringIndex, j) => { const name = SNAPSHOT_STYLES[j]; if (name) style[name] = stringAt(stringIndex); });
      if (!node.style) node.style = style;
      const bounds = layout.bounds[k];
      if (bounds && !node.bounds) node.bounds = { x: bounds[0] ?? 0, y: bounds[1] ?? 0, width: bounds[2] ?? 0, height: bounds[3] ?? 0 };
      const blended = layout.blendedBackgroundColors?.[k];
      if (blended !== undefined && blended >= 0) extras.blendedBackground.set(offset + nodeIndex, stringAt(blended));
      const opacity = layout.textColorOpacities?.[k];
      if (opacity !== undefined) extras.textOpacity.set(offset + nodeIndex, opacity);
      const scrollRectangle = layout.scrollRects?.[k];
      const clientRectangle = layout.clientRects?.[k];
      if (scrollRectangle && clientRectangle && !extras.scroll.has(offset + nodeIndex)) {
        extras.scroll.set(offset + nodeIndex, [scrollRectangle[2] ?? 0, scrollRectangle[3] ?? 0, clientRectangle[2] ?? 0, clientRectangle[3] ?? 0]);
      }
    });
  });
  // Children, accessibility information and the backend id index.
  for (const node of nodes) {
    if (node.parent >= 0) nodes[node.parent]?.children.push(node.index);
    const info = accessibility.get(node.backendId);
    if (info && node.nodeType === 1) node.accessibility = info;
    if (node.nodeType === 1 && !indexByBackend.has(node.backendId)) indexByBackend.set(node.backendId, node.index);
  }
  for (const [backendId, ownedBackendIds] of ownedByBackend) {
    const index = indexByBackend.get(backendId);
    if (index !== undefined) {
      extras.owned.set(index, ownedBackendIds.map((owned) => indexByBackend.get(owned)).filter((owned): owned is number => owned !== undefined));
    }
  }
  // Frame documents hang under their frame element, with boxes moved into top-document coordinates.
  captured.documents.forEach((documentSnapshot, documentIndex) => {
    const contentDocuments = documentSnapshot.nodes.contentDocumentIndex;
    if (!contentDocuments) return;
    contentDocuments.index.forEach((nodeIndex, k) => {
      const owner = nodes[(offsets[documentIndex] ?? 0) + nodeIndex];
      const childDocument = contentDocuments.value[k];
      if (owner === undefined || childDocument === undefined) return;
      const rootIndex = offsets[childDocument] ?? -1;
      const root = nodes[rootIndex];
      if (!root) return;
      owner.contentDocument = rootIndex;
      root.parent = owner.index;
      owner.children.push(rootIndex);
      // Approximate: frame borders are ignored.
      const ownerBounds = owner.bounds;
      if (ownerBounds) {
        const shift = (box: Box | null): Box | null => (box ? { ...box, x: box.x + ownerBounds.x, y: box.y + ownerBounds.y } : box);
        const end = childDocument + 1 < offsets.length ? (offsets[childDocument + 1] ?? nodes.length) : nodes.length;
        for (let i = rootIndex; i < end; i++) {
          const shifted = nodes[i];
          if (shifted) shifted.bounds = shift(shifted.bounds);
        }
      }
    });
  });
  const roots = offsets.filter((offset) => (nodes[offset]?.parent ?? -1) < 0);
  const metrics = await session.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics');
  extras.contentType = await session.send<{ result: { value?: string } }>('Runtime.evaluate', { expression: 'document.contentType', returnByValue: true })
    .then((evaluated) => evaluated.result.value ?? '', () => '');
  const snapshot: PageSnapshot = {
    url: stringAt(captured.documents[0]?.documentURL), nodes, roots,
    viewport: { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight },
  };
  extrasBySnapshot.set(snapshot, extras);
  return snapshot;
}
