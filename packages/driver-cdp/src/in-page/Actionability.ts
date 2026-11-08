/// <reference lib="dom" />
// Whether an element can be acted on, and where a press at it lands.
// Each runs inside the page and is sent with toString(), so it is self-contained: no
// imports and no closures over Node values. A form's named inputs hide what it inherits, so whatever
// may be a form is read through the prototypes, never directly.

// Actionability: attached, visible, stable over two animation frames, and the hit test at the centre
// lands on the element. Scrolls it into view first. Whether it is enabled is enabledState's to say.
export async function actionability(element: Element): Promise<string> {
  const nextFrame = (): Promise<void> => new Promise((resolve) => {
    let isDone = false;
    const finish = (): void => { if (!isDone) { isDone = true; resolve(); } };
    requestAnimationFrame(() => finish());
    setTimeout(finish, 50); // a hidden or throttled page may not paint
  });
  const none = { attached: false, visible: false, stable: false, receivesEvents: false, centre: null };
  const isConnected = (): boolean => Reflect.get(Node.prototype, 'isConnected', element);
  const boxOf = (): DOMRect => Element.prototype.getBoundingClientRect.call(element);
  const rootOf = (node: Element): ShadowRoot | null => Reflect.get(Element.prototype, 'shadowRoot', node);
  if (!isConnected()) {return JSON.stringify(none);}
  const style = getComputedStyle(element);
  const first = boxOf();
  const isVisible = first.width > 0 && first.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  if (!isVisible) {return JSON.stringify({ ...none, attached: true });}
  const isInView = first.top >= 0 && first.left >= 0 && first.bottom <= innerHeight && first.right <= innerWidth;
  if (!isInView) {Element.prototype.scrollIntoView.call(element, { block: 'center', inline: 'center', behavior: 'instant' });}
  await nextFrame();
  const before = boxOf();
  await nextFrame();
  const after = boxOf();
  const isStable = before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height;
  // An inline element that wraps onto a second line has one box per line, and the centre of the
  // box around them all may fall between them; the centre of its first box is on the element.
  const firstBox = Array.from(Element.prototype.getClientRects.call(element)).find((box) => box.width > 0 && box.height > 0) ?? after;
  const centre = { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height / 2 };
  // The document answers with a shadow host; only its root can say what is drawn there.
  let hit = document.elementFromPoint(centre.x, centre.y);
  let inner = hit === null ? null : rootOf(hit)?.elementFromPoint(centre.x, centre.y) ?? null;
  while (inner !== null && inner !== hit) {
    hit = inner;
    inner = rootOf(hit)?.elementFromPoint(centre.x, centre.y) ?? null;
  }
  const parentOf = (node: Element): Element | null => {
    const slot = Reflect.get(Element.prototype, 'assignedSlot', node);
    if (slot !== null) {
      return slot;
    }
    const parent = Reflect.get(Node.prototype, 'parentElement', node);
    if (parent !== null) {
      return parent;
    }
    const root = Node.prototype.getRootNode.call(node);
    return root instanceof ShadowRoot ? root.host : null;
  };
  let isHit = false;
  for (let node = hit; node !== null && !isHit; node = parentOf(node)) {
    isHit = node === element;
  }
  const label = hit === null ? null : Element.prototype.closest.call(hit, 'label');
  const isViaLabel = label instanceof HTMLLabelElement && label.control === element;
  const isReceivingEvents = isHit || isViaLabel;
  return JSON.stringify({ attached: isConnected(), visible: true, stable: isStable, receivesEvents: isReceivingEvents, centre });
}

// What a pointer press at the point would really act on, other than `element`: the element it would
// hit, and what is interactive around that, up to and including the nearest control. A handler or a
// tab stop does not end the search, since a press goes on to the control around it. A label's press
// goes to its control. Controls beside the point are not there, so a card is not judged by a button
// it also holds.
export function whatAClickActivates(element: Element, x: number, y: number): Element[] {
  const controls = 'a[href], area[href], button, input, select, textarea, summary, option, label, [role="button"], [role="link"], [role="checkbox"], '
    + '[role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="treeitem"]';
  const rootOf = (node: Element): ShadowRoot | null => Reflect.get(Element.prototype, 'shadowRoot', node);
  let hit = document.elementFromPoint(x, y);
  let inner = hit === null ? null : rootOf(hit)?.elementFromPoint(x, y) ?? null;
  while (inner !== null && inner !== hit) {
    hit = inner;
    inner = rootOf(hit)?.elementFromPoint(x, y) ?? null;
  }
  if (hit === null) {
    return [];
  }
  const parentOf = (node: Element): Element | null => {
    const slot = Reflect.get(Element.prototype, 'assignedSlot', node);
    if (slot !== null) {
      return slot;
    }
    const parent = Reflect.get(Node.prototype, 'parentElement', node);
    if (parent !== null) {
      return parent;
    }
    const root = Node.prototype.getRootNode.call(node);
    return root instanceof ShadowRoot ? root.host : null;
  };
  const activated = new Set<Element>([hit]);
  const addLabelled = (node: Element): void => {
    if (node instanceof HTMLLabelElement && node.control !== null) {
      activated.add(node.control);
    }
  };
  addLabelled(hit);
  for (let node = parentOf(hit); node !== null; node = parentOf(node)) {
    addLabelled(node);
    if (Element.prototype.matches.call(node, '[onclick], [tabindex]')) {
      activated.add(node);
    }
    if (Element.prototype.matches.call(node, controls)) {
      activated.add(node);
      break;
    }
  }
  activated.delete(element);
  return Array.from(activated);
}

// Where an iframe's document starts in its parent's viewport, as JSON {x, y}: the iframe's box
// plus its border and padding. The iframe is scrolled into view first, so its contents can be hit.
export function frameContentOffset(frame: Element): string {
  const first = frame.getBoundingClientRect();
  const isInView = first.top >= 0 && first.left >= 0 && first.bottom <= innerHeight && first.right <= innerWidth;
  if (!isInView) {frame.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });}
  const rectangle = frame.getBoundingClientRect();
  const style = getComputedStyle(frame);
  const pixels = (value: string): number => { const parsed = Number.parseFloat(value); return Number.isNaN(parsed) ? 0 : parsed; };
  return JSON.stringify({
    x: rectangle.x + frame.clientLeft + pixels(style.paddingLeft),
    y: rectangle.y + frame.clientTop + pixels(style.paddingTop),
  });
}
