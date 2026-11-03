/// <reference lib="dom" />
// Functions that run inside the page. They are sent with toString(), so each must be
// self-contained: no imports and no closures over Node values. Every protocol uses the same
// functions, so a probe or an actionability check means the same thing everywhere.
// What a person sees includes what is drawn in open shadow roots, so these functions look through
// them too; FindByLabel.ts says how, and holds the functions that find a locator's elements.

// A snapshot of one element as JSON, in the shape of ElementProbe.
export function probeElement(element: Element, selectors: readonly string[]): string {
  const rectangle = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const visible = rectangle.width > 0 && rectangle.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  const disabled = (element as HTMLInputElement).disabled === true || element.getAttribute('aria-disabled') === 'true';
  const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
  const selectorList = selectors.join(',');
  const parentOf = (node: Element): Element | null => {
    if (node.assignedSlot !== null) {
      return node.assignedSlot;
    }
    if (node.parentElement !== null) {
      return node.parentElement;
    }
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  const isInsideMatch = (): boolean => {
    for (let node: Element | null = element; node !== null; node = parentOf(node)) {
      if (node.matches(selectorList)) {
        return true;
      }
    }
    return false;
  };
  const hasMatchInside = (): boolean => {
    const scopes: (Element | ShadowRoot)[] = element.shadowRoot === null ? [element] : [element, element.shadowRoot];
    for (const scope of scopes) {
      if (scope.querySelector(selectorList) !== null) {
        return true;
      }
      for (const inner of Array.from(scope.querySelectorAll('*'))) {
        if (inner.shadowRoot !== null) {
          scopes.push(inner.shadowRoot);
        }
      }
    }
    return false;
  };
  const sensitive = selectorList !== '' && (isInsideMatch() || hasMatchInside());
  return JSON.stringify({
    count: 1, visible, enabled: !disabled,
    // An SVG element has no innerText, whatever the type says.
    text: (element as Partial<HTMLElement>).innerText ?? element.textContent,
    value: isField ? (element as HTMLInputElement).value : null,
    sensitive,
    box: { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height },
  });
}

// Actionability: attached, visible, stable over two animation frames, enabled, and the hit test at
// the centre lands on the element. Scrolls it into view first.
export async function actionability(element: Element): Promise<string> {
  const nextFrame = (): Promise<void> => new Promise((resolve) => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => finish());
    setTimeout(finish, 50); // a hidden or throttled page may not paint
  });
  const none = { attached: false, visible: false, stable: false, enabled: false, receivesEvents: false, centre: null };
  if (!element.isConnected) return JSON.stringify(none);
  const style = getComputedStyle(element);
  const first = element.getBoundingClientRect();
  const visible = first.width > 0 && first.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  const disabled = (element as HTMLButtonElement).disabled === true || element.getAttribute('aria-disabled') === 'true'
    || element.closest('fieldset[disabled]') !== null;
  if (!visible) return JSON.stringify({ ...none, attached: true, enabled: !disabled });
  const inView = first.top >= 0 && first.left >= 0 && first.bottom <= innerHeight && first.right <= innerWidth;
  if (!inView) element.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  await nextFrame();
  const before = element.getBoundingClientRect();
  await nextFrame();
  const after = element.getBoundingClientRect();
  const stable = before.x === after.x && before.y === after.y && before.width === after.width && before.height === after.height;
  // An inline element that wraps onto a second line has one box per line, and the centre of the
  // box around them all may fall between them; the centre of its first box is on the element.
  const firstBox = Array.from(element.getClientRects()).find((box) => box.width > 0 && box.height > 0) ?? after;
  const centre = { x: firstBox.x + firstBox.width / 2, y: firstBox.y + firstBox.height / 2 };
  // The document answers with a shadow host; only its root can say what is drawn there.
  let hit = document.elementFromPoint(centre.x, centre.y);
  let inner = hit?.shadowRoot?.elementFromPoint(centre.x, centre.y) ?? null;
  while (inner !== null && inner !== hit) {
    hit = inner;
    inner = hit.shadowRoot?.elementFromPoint(centre.x, centre.y) ?? null;
  }
  const parentOf = (node: Element): Element | null => {
    if (node.assignedSlot !== null) {
      return node.assignedSlot;
    }
    if (node.parentElement !== null) {
      return node.parentElement;
    }
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  let isHit = false;
  for (let node = hit; node !== null && !isHit; node = parentOf(node)) {
    isHit = node === element;
  }
  const viaLabel = hit !== null && hit.closest('label') !== null && (hit.closest('label') as HTMLLabelElement).control === element;
  const receivesEvents = isHit || viaLabel;
  return JSON.stringify({ attached: element.isConnected, visible: true, stable, enabled: !disabled, receivesEvents, centre });
}

// What a pointer press at the point would really act on, other than `element`: the element it would
// hit, and what is interactive around that, up to and including the nearest control. A handler or a
// tab stop does not end the search, since a press goes on to the control around it. A label's press
// goes to its control. Controls beside the point are not there, so a card is not judged by a button
// it also holds.
export function whatAClickActivates(element: Element, x: number, y: number): Element[] {
  const controls = 'a[href], area[href], button, input, select, textarea, summary, option, label, [role="button"], [role="link"], [role="checkbox"], '
    + '[role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="treeitem"]';
  let hit = document.elementFromPoint(x, y);
  let inner = hit?.shadowRoot?.elementFromPoint(x, y) ?? null;
  while (inner !== null && inner !== hit) {
    hit = inner;
    inner = hit.shadowRoot?.elementFromPoint(x, y) ?? null;
  }
  if (hit === null) {
    return [];
  }
  const parentOf = (node: Element): Element | null => {
    if (node.assignedSlot !== null) {
      return node.assignedSlot;
    }
    if (node.parentElement !== null) {
      return node.parentElement;
    }
    const root = node.getRootNode();
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
    if (node.matches('[onclick], [tabindex]')) {
      activated.add(node);
    }
    if (node.matches(controls)) {
      activated.add(node);
      break;
    }
  }
  activated.delete(element);
  return Array.from(activated);
}

// Paints a solid black box over every element matching the selectors, in any open shadow root too:
// an element a locator can find must be one a mask can reach.
export function maskElements(selectors: readonly string[]): string {
  const selectorList = selectors.join(',');
  if (selectorList === '') return '0';
  const elements: Element[] = [];
  const roots: (Document | ShadowRoot)[] = [document];
  for (const root of roots) {
    elements.push(...Array.from(root.querySelectorAll(selectorList)));
    for (const element of Array.from(root.querySelectorAll('*'))) {
      if (element.shadowRoot !== null) {
        roots.push(element.shadowRoot);
      }
    }
  }
  for (const element of elements) {
    const rectangle = element.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-mask-overlay', '');
    overlay.style.cssText = `position:fixed;left:${rectangle.x}px;top:${rectangle.y}px;width:${rectangle.width}px;height:${rectangle.height}px;background:#000;z-index:2147483647;pointer-events:none`;
    document.documentElement.appendChild(overlay);
  }
  return String(elements.length);
}

// Paints the same box over each of the given elements. unmaskElements takes these away too.
// What every field in the document holds, as JSON. The caller only compares it, and keeps none of it.
export function fieldValues(): string {
  const fields = [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')].map((field) => field.value);
  const editable = [...document.querySelectorAll('[contenteditable]:not([contenteditable="false"])')].map((element) => element.textContent);
  return JSON.stringify([...fields, ...editable]);
}

export function maskGivenElements(...elements: Element[]): string {
  for (const element of elements) {
    const rectangle = element.getBoundingClientRect();
    const overlay = document.createElement('div');
    overlay.setAttribute('data-mask-overlay', '');
    overlay.style.cssText = `position:fixed;left:${rectangle.x}px;top:${rectangle.y}px;width:${rectangle.width}px;height:${rectangle.height}px;background:#000;z-index:2147483647;pointer-events:none`;
    document.documentElement.appendChild(overlay);
  }
  return String(elements.length);
}

export function unmaskElements(): string {
  for (const overlay of Array.from(document.querySelectorAll('[data-mask-overlay]'))) overlay.remove();
  return 'ok';
}

// The URL of the document this runs in: the browser's own internal one on its error page.
export function documentUrl(): string {
  return location.href;
}

// Waits for web fonts; returns the font set's status.
export async function fontsReady(): Promise<string> {
  await document.fonts.ready;
  return document.fonts.status;
}

// The page's URL and title, and what its head says about it: every <meta> with a content and a
// name or property (once for each), and the resolved href of its canonical link, or null.
export function pageInfo(): string {
  const meta: { name: string; content: string }[] = [];
  for (const tag of Array.from(document.querySelectorAll('meta[content]'))) {
    const content = tag.getAttribute('content') ?? '';
    for (const attribute of ['name', 'property']) {
      const name = tag.getAttribute(attribute);
      if (name !== null && name !== '') meta.push({ name, content });
    }
  }
  const canonical = Array.from(document.querySelectorAll('link[href]'))
    .find((link) => link instanceof HTMLLinkElement && link.relList.contains('canonical'));
  return JSON.stringify({
    url: location.href, title: document.title, meta, canonicalUrl: canonical instanceof HTMLLinkElement ? canonical.href : null,
  });
}

// The absolute URLs of the document's links, as JSON: every a and area element with an href, in
// document order, as the browser resolves each against the page's URL. Nothing is clicked or changed.
export function linkTargetList(): string {
  return JSON.stringify(Array.from(document.links).map((link) => link.href));
}

// What a probe reads besides the accessibility tree, as JSON: the absolute href of the link the
// element is, or is in (null outside a link), and its aria-current state. Any aria-current value but
// "false" (or empty) is current. With none, a link or a control is not current; any other element
// does not expose the state ("none").
export function linkAndCurrent(element: Element): string {
  const parentOf = (node: Element): Element | null => {
    if (node.assignedSlot !== null) {
      return node.assignedSlot;
    }
    if (node.parentElement !== null) {
      return node.parentElement;
    }
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  let link: Element | null = element;
  while (link !== null && !link.matches('a[href], area[href]')) link = parentOf(link);
  const href = link instanceof HTMLAnchorElement || link instanceof HTMLAreaElement ? link.href : null;
  const CONTROL_ROLES = ['link', 'button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'gridcell', 'row', 'checkbox', 'radio', 'switch'];
  const declared = element.getAttribute('aria-current');
  let current: string;
  if (declared !== null) current = declared.trim() === '' || declared.trim().toLowerCase() === 'false' ? 'false' : 'true';
  else {
    const role = (element.getAttribute('role') ?? '').trim().split(/\s+/)[0] ?? '';
    const control = element.matches('a[href], area[href], button, input, select, textarea, summary, option') || CONTROL_ROLES.includes(role);
    current = control ? 'false' : 'none';
  }
  return JSON.stringify({ href, current });
}

// Focuses an element and selects its contents, ready for a fill.
export function focusAndSelect(element: HTMLInputElement): string {
  element.focus();
  if (typeof element.select === 'function') element.select();
  return 'ok';
}

export function focusElement(element: HTMLElement): string {
  element.focus();
  return 'ok';
}

// What the policy gate's runtime guard needs to know about an element besides its role and name,
// as JSON: its box, the accessible name of its form's submit control, the URL of the link it is
// in, and its own test id. A field the page does not show is null.
export function guardDetails(element: Element): string {
  const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const nameOf = (control: Element): string => {
    const ariaLabel = control.getAttribute('aria-label');
    if (ariaLabel !== null && normalise(ariaLabel) !== '') return normalise(ariaLabel);
    const labelledBy = control.getAttribute('aria-labelledby');
    if (labelledBy !== null) {
      const root = control.getRootNode() as Document | ShadowRoot;
      const text = normalise(labelledBy.split(/\s+/).map((id) => root.getElementById(id)?.textContent ?? '').join(' '));
      if (text !== '') return text;
    }
    if (control instanceof HTMLInputElement && control.type === 'image') return normalise(control.alt);
    if (control instanceof HTMLInputElement) { return normalise(control.value === '' ? 'Submit' : control.value); }
    // An SVG element has no innerText, whatever the type says.
    return normalise((control as Partial<HTMLElement>).innerText ?? control.textContent);
  };
  const rectangle = element.getBoundingClientRect();
  const field = element as HTMLInputElement;
  const form = field.form instanceof HTMLFormElement ? field.form : element.closest('form');
  const submit = form === null ? undefined : Array.from(form.elements).find((control) =>
    (control instanceof HTMLButtonElement && control.type === 'submit')
    || (control instanceof HTMLInputElement && (control.type === 'submit' || control.type === 'image')));
  const submitName = submit === undefined ? '' : nameOf(submit);
  const parentOf = (node: Element): Element | null => {
    if (node.assignedSlot !== null) {
      return node.assignedSlot;
    }
    if (node.parentElement !== null) {
      return node.parentElement;
    }
    const root = node.getRootNode();
    return root instanceof ShadowRoot ? root.host : null;
  };
  let link: Element | null = element;
  while (link !== null && !link.matches('a[href]')) link = parentOf(link);
  return JSON.stringify({
    box: { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height },
    formSubmitName: submitName === '' ? null : submitName,
    linkUrl: link instanceof HTMLAnchorElement ? link.href : null,
    testId: element.getAttribute('data-testid'),
  });
}

// Chooses the option of a select whose visible text, or else whose value, is `option`, and fires
// the input and change events a person's choice fires. Returns 'selected', 'no-option' or
// 'not-a-select'.
export function selectOption(element: Element, option: string): string {
  const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();
  if (!(element instanceof HTMLSelectElement)) return 'not-a-select';
  const options = Array.from(element.options);
  const chosen = options.find((candidate) => normalise(candidate.label === '' ? candidate.text : candidate.label) === normalise(option))
    ?? options.find((candidate) => candidate.value === option);
  if (chosen === undefined) return 'no-option';
  element.value = chosen.value;
  element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  return 'selected';
}

// Where an iframe's document starts in its parent's viewport, as JSON {x, y}: the iframe's box
// plus its border and padding. The iframe is scrolled into view first, so its contents can be hit.
export function frameContentOffset(frame: Element): string {
  const first = frame.getBoundingClientRect();
  const inView = first.top >= 0 && first.left >= 0 && first.bottom <= innerHeight && first.right <= innerWidth;
  if (!inView) frame.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const rectangle = frame.getBoundingClientRect();
  const style = getComputedStyle(frame);
  const pixels = (value: string): number => { const parsed = Number.parseFloat(value); return Number.isNaN(parsed) ? 0 : parsed; };
  return JSON.stringify({
    x: rectangle.x + frame.clientLeft + pixels(style.paddingLeft),
    y: rectangle.y + frame.clientTop + pixels(style.paddingTop),
  });
}

// True when the element belongs to this document, not to a frame inside it.
export function inThisDocument(element: Element): string {
  return element.ownerDocument === document ? 'yes' : 'no';
}

// Called on an element, as `this`, so it runs in that element's own world and document.
export function isConnectedToItsDocument(this: Element): boolean {
  return this.isConnected;
}

// Advances this document's virtual clock to `target` milliseconds after the frozen start, through
// the determinism kit's advance controller in the page's main world, where the page's timers are.
// A document without the controller, such as one loaded with scripts off, fires nothing. Gives
// how many callbacks fired and whether the limit stopped it.
export async function advanceDocumentClock(controllerKey: string, target: number, mode: string, maximumCallbacks: number): Promise<unknown> {
  type Controller = { advanceTo(target: number, mode: string, maximumCallbacks: number): Promise<unknown> };
  const controller = (window as unknown as Record<symbol, Controller | undefined>)[Symbol.for(controllerKey)];
  if (controller === undefined) return { fired: 0, runaway: false };
  return controller.advanceTo(target, mode, maximumCallbacks);
}

// The run's clipboard as plain text, line endings normalised to "\n", cut after
// maximumCharacters + 1 characters. Called in an isolated world, only while the driver holds the
// clipboard-read permission, so the page's own scripts never see the read.
export async function readClipboardText(maximumCharacters: number): Promise<string> {
  const text = await navigator.clipboard.readText();
  return text.replace(/\r\n?/g, '\n').slice(0, maximumCharacters + 1);
}

// Waits two animation frames, so whatever an action started (a popup, a download) has reached
// the browser before the driver looks.
export async function afterTwoFrames(): Promise<string> {
  const nextFrame = (): Promise<void> => new Promise((resolve) => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(); } };
    requestAnimationFrame(() => finish());
    setTimeout(finish, 50); // a hidden or throttled page may not paint
  });
  await nextFrame();
  await nextFrame();
  return 'ok';
}

// 'valid' when the browser accepts the css selector or XPath expression, 'invalid' when it rejects
// it, or when the XPath expression gives no list of nodes (such as count()), so a locator holding
// it can never match anything.
export function structuralSelectorValidity(kind: string, text: string): string {
  try {
    if (kind === 'css') document.createDocumentFragment().querySelector(text);
    else document.evaluate(text, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
    return 'valid';
  } catch {
    return 'invalid';
  }
}

// One DOM read of the element, as JSON in the shape of DomValue: its class tokens, the computed
// value of the style property `name`, or the value of the attribute `name` (null when absent).
export function readDomValue(element: Element, kind: string, name: string): string {
  if (kind === 'classes') return JSON.stringify({ kind, classes: Array.from(element.classList) });
  if (kind === 'computedStyle') return JSON.stringify({ kind, value: getComputedStyle(element).getPropertyValue(name) });
  return JSON.stringify({ kind: 'attribute', value: element.getAttribute(name) });
}

// A page script's result written as JSON text, as ['text', text], or ['not-json'] when JSON cannot
// write it: undefined, a function or a symbol, or a value that is cyclic or holds a bigint. UTF-8
// never takes fewer bytes than the text has UTF-16 code units, so text longer than the byte limit
// in code units is over it in bytes too: only one code unit past the limit is sent back.
export function scriptResultText(value: unknown, maximumResultBytes: number): string[] {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return ['not-json'];
  let text: unknown;
  try {
    text = JSON.stringify(value);
  } catch {
    return ['not-json'];
  }
  if (typeof text !== 'string') return ['not-json'];
  return ['text', text.length > maximumResultBytes ? text.slice(0, maximumResultBytes + 1) : text];
}
