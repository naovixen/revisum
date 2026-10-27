/// <reference lib="dom" />
// Functions that run inside the page. Playwright sends them with toString(), so each must be
// self-contained: no imports and no closures over Node values. They give the same results as the
// own CDP driver's page functions, so a probe means the same thing on every driver.

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
    count: 1,
    visible,
    enabled: !disabled,
    text: (element as HTMLElement).innerText ?? element.textContent ?? '',
    value: isField ? (element as HTMLInputElement).value : null,
    sensitive,
    box: { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height },
  });
}

// A small, approximate accessibility tree: the implicit or explicit role plus a computed name.
export function accessibilitySnapshot(): string {
  type TreeNode = { role: string; name: string; children: TreeNode[] };
  // Keyed by HTML tag name, as Element.tagName gives it.
  const implicitRoles: Record<string, string> = {
    'A': 'link', 'BUTTON': 'button', 'H1': 'heading', 'H2': 'heading', 'H3': 'heading', 'H4': 'heading',
    'IMG': 'img', 'MAIN': 'main', 'NAV': 'navigation', 'FORM': 'form', 'SELECT': 'combobox', 'TEXTAREA': 'textbox', 'UL': 'list', 'LI': 'listitem',
  };
  const normalise = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const roleOf = (element: Element): string | null => {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    if (element instanceof HTMLInputElement) {
      return element.type === 'checkbox' ? 'checkbox' : element.type === 'radio' ? 'radio' : element.type === 'submit' ? 'button' : 'textbox';
    }
    return implicitRoles[element.tagName] ?? null;
  };
  const nameOf = (element: Element): string => {
    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) return normalise(ariaLabel);
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
      return normalise(Array.from(element.labels ?? []).map((label) => label.textContent ?? '').join(' '));
    }
    if (element instanceof HTMLImageElement) return normalise(element.alt ?? '');
    return normalise((element as HTMLElement).innerText ?? '');
  };
  const walk = (element: Element): TreeNode[] => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || element.getAttribute('aria-hidden') === 'true') return [];
    const children = Array.from(element.children).flatMap(walk);
    const role = roleOf(element);
    return role ? [{ role, name: nameOf(element), children }] : children;
  };
  return JSON.stringify({ role: 'document', name: document.title, children: walk(document.body) });
}
