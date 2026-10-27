/// <reference lib="dom" />
// Functions that run inside the page. They are sent with toString(), so each must be
// self-contained: no imports and no closures over Node values. Every protocol uses the same
// functions, so a probe or an actionability check means the same thing everywhere.

// A snapshot of one element as JSON, in the shape of ElementProbe.
export function probeElement(element: Element, selectors: readonly string[]): string {
  const rectangle = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const visible = rectangle.width > 0 && rectangle.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  const disabled = (element as HTMLInputElement).disabled === true || element.getAttribute('aria-disabled') === 'true';
  const isField = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
  const selectorList = selectors.join(',');
  const sensitive = selectorList !== ''
    && (element.matches(selectorList) || element.closest(selectorList) !== null || element.querySelector(selectorList) !== null);
  return JSON.stringify({
    count: 1, visible, enabled: !disabled,
    text: (element as HTMLElement).innerText ?? element.textContent ?? '',
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
  const centre = { x: after.x + after.width / 2, y: after.y + after.height / 2 };
  const hit = document.elementFromPoint(centre.x, centre.y);
  const viaLabel = hit !== null && hit.closest('label') !== null && (hit.closest('label') as HTMLLabelElement).control === element;
  const receivesEvents = hit !== null && (hit === element || element.contains(hit) || viaLabel);
  return JSON.stringify({ attached: element.isConnected, visible: true, stable, enabled: !disabled, receivesEvents, centre });
}

// Arms a one-shot hit-target check before a pointer click: pointer and mouse events whose target
// is not the element (or its label) are swallowed and recorded as a miss, so a click that lands on
// something else has no effect and can be retried.
export function armHitCheck(element: Element): string {
  type HitCheck = { state: string; disarm: () => void };
  type WindowWithCheck = Window & { __clickHitCheck?: HitCheck };
  const page = window as WindowWithCheck;
  page.__clickHitCheck?.disarm();
  const eventTypes = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
  const check: HitCheck = { state: 'none', disarm: () => { for (const eventType of eventTypes) window.removeEventListener(eventType, listen, true); } };
  function listen(event: Event): void {
    const target = event.target instanceof Element ? event.target : null;
    const label = target?.closest('label') as HTMLLabelElement | null;
    const onElement = target !== null && (target === element || element.contains(target) || label?.control === element);
    if (onElement) {
      if (check.state === 'none') check.state = 'hit';
      return;
    }
    check.state = 'miss';
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  for (const eventType of eventTypes) window.addEventListener(eventType, listen, true);
  page.__clickHitCheck = check;
  return 'armed';
}

// Reads and disarms the hit-target check: 'hit', 'miss' or 'none'.
export function readHitCheck(): string {
  type WindowWithCheck = Window & { __clickHitCheck?: { state: string; disarm: () => void } };
  const page = window as WindowWithCheck;
  const check = page.__clickHitCheck;
  if (!check) return 'none';
  check.disarm();
  delete page.__clickHitCheck;
  return check.state;
}

// Elements labelled exactly `label`: label[for], a wrapping label, aria-label or aria-labelledby.
export function findByLabel(label: string): Element[] {
  const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const found = new Set<Element>();
  for (const labelElement of Array.from(document.querySelectorAll('label'))) {
    if (labelElement.control && normalise(labelElement.textContent ?? '') === label) found.add(labelElement.control);
  }
  for (const element of Array.from(document.querySelectorAll('[aria-label]'))) {
    if (normalise(element.getAttribute('aria-label') ?? '') === label) found.add(element);
  }
  for (const element of Array.from(document.querySelectorAll('[aria-labelledby]'))) {
    const ids = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/);
    if (normalise(ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ')) === label) found.add(element);
  }
  return Array.from(found);
}

// The deepest elements whose rendered text is exactly `text`.
export function findByText(text: string): Element[] {
  const normalise = (value: string): string => value.replace(/\s+/g, ' ').trim();
  const matches = Array.from(document.body.querySelectorAll('*')).filter(
    (element) => !['SCRIPT', 'STYLE', 'TEMPLATE'].includes(element.tagName) && normalise((element as HTMLElement).innerText ?? '') === text,
  );
  return matches.filter((element) => !matches.some((other) => other !== element && element.contains(other)));
}

export function findByTestId(testId: string): Element[] {
  return Array.from(document.querySelectorAll('[data-testid]')).filter((element) => element.getAttribute('data-testid') === testId);
}

// Paints a solid black box over every element matching the selectors.
export function maskElements(selectors: readonly string[]): string {
  const selectorList = selectors.join(',');
  if (selectorList === '') return '0';
  const elements = Array.from(document.querySelectorAll(selectorList));
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

// Waits for web fonts; returns the font set's status.
export async function fontsReady(): Promise<string> {
  await document.fonts.ready;
  return document.fonts.status;
}

export function pageInfo(): string {
  return JSON.stringify({ url: location.href, title: document.title });
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
