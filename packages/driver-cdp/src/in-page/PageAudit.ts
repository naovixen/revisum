/// <reference lib="dom" />
// A small, engine-neutral set of accessibility checks that runs in the page, so the Auditor port
// works without a third-party engine. It serves the driver's audit step and gives the report the
// boxes of failing elements; the full rules engine lives in the auditor-act package. Rule ids use
// the common short names, so findings line up across engines.

// Runs in the page and returns the failing rules as JSON. Self-contained: sent with toString(). It is
// given PAGE_AUDIT_RULES as JSON, so each rule's ACT rule, WCAG criteria and impact are written once.
export function pageAudit(ruleTable: string): string {
  type RuleDetails = { actRule: string | null; wcag: string[]; impact: string };
  const details = JSON.parse(ruleTable) as Record<string, RuleDetails | undefined>;
  type PageBox = { x: number; y: number; width: number; height: number };
  type FailingNode = { selector: string; box: PageBox | null; offscreen: boolean; snippet: string };
  type FailingRule = { ruleId: string; actRule: string | null; wcag: string[]; impact: string; nodes: FailingNode[] };
  const normalise = (text: string | null | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();
  const escapeIdent = (text: string): string => CSS.escape(text);
  const selectorOf = (element: Element): string => {
    const unique = (candidate: Element): boolean => candidate.id !== '' && document.querySelectorAll(`#${escapeIdent(candidate.id)}`).length === 1;
    const parts: string[] = [];
    let current: Element | null = element;
    while (current !== null && current !== document.documentElement) {
      if (unique(current)) { parts.unshift(`#${escapeIdent(current.id)}`); return parts.join(' > '); }
      const tag = current.tagName.toLowerCase();
      const parent: Element | null = current.parentElement;
      const sameTag = parent === null ? [] : Array.from(parent.children).filter((sibling) => sibling.tagName === current?.tagName);
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(current) + 1})` : tag);
      current = parent;
    }
    parts.unshift('html');
    return parts.join(' > ');
  };
  const describe = (element: Element): FailingNode => {
    const rectangle = element.getBoundingClientRect();
    const rendered = rectangle.width > 0 && rectangle.height > 0;
    const box = rendered ? { x: rectangle.x + scrollX, y: rectangle.y + scrollY, width: rectangle.width, height: rectangle.height } : null;
    const offscreen = box === null || box.x >= innerWidth || box.y >= innerHeight || box.x + box.width <= 0 || box.y + box.height <= 0;
    return { selector: selectorOf(element), box, offscreen, snippet: element.outerHTML.slice(0, 120) };
  };
  const hidden = (element: Element): boolean => {
    if (element.closest('[aria-hidden="true"]') !== null) return true;
    const style = getComputedStyle(element);
    return style.display === 'none' || style.visibility === 'hidden';
  };
  const labelledByText = (element: Element): string => normalise((element.getAttribute('aria-labelledby') ?? '').split(/\s+/)
    .map((id) => (id === '' ? '' : document.getElementById(id)?.textContent ?? '')).join(' '));
  const textName = (element: Element): string => {
    const alternatives = Array.from(element.querySelectorAll('img[alt]')).map((image) => image.getAttribute('alt') ?? '').join(' ');
    // An SVG element has no innerText, whatever the type says.
    return normalise(`${(element as Partial<HTMLElement>).innerText ?? element.textContent} ${alternatives}`);
  };
  const explicitName = (element: Element): string =>
    [normalise(element.getAttribute('aria-label')), labelledByText(element), normalise(element.getAttribute('title'))].find((name) => name !== '') ?? '';
  const shown = (selector: string): Element[] => Array.from(document.querySelectorAll(selector)).filter((element) => !hidden(element));
  const rules: FailingRule[] = [];
  const add = (ruleId: string, elements: Element[]): void => {
    const rule = details[ruleId];
    if (rule !== undefined && elements.length > 0) rules.push({ ruleId, actRule: rule.actRule, wcag: rule.wcag, impact: rule.impact, nodes: elements.map(describe) });
  };

  // 1.1.1 Image has an accessible name.
  add('image-alt', shown('img').filter((element) => {
    const role = element.getAttribute('role');
    if (role === 'presentation' || role === 'none') return false;
    return !element.hasAttribute('alt') && explicitName(element) === '';
  }));

  // 4.1.2 Button has an accessible name.
  add('button-name', shown('button, input[type="button"], [role="button"]').filter((element) => {
    if (element instanceof HTMLInputElement) return normalise(element.value) === '' && explicitName(element) === '';
    return textName(element) === '' && explicitName(element) === '';
  }));

  // 2.4.4, 4.1.2 Link has an accessible name.
  add('link-name', shown('a[href], [role="link"]').filter((element) => textName(element) === '' && explicitName(element) === ''));

  // 4.1.2 Form field has an accessible name.
  const unlabelledTypes = ['hidden', 'submit', 'reset', 'button', 'image'];
  add('label', shown('input, select, textarea').filter((element) => {
    if (element instanceof HTMLInputElement && unlabelledTypes.includes(element.type)) return false;
    const labels = normalise(Array.from((element as HTMLInputElement).labels ?? []).map((label) => label.textContent).join(' '));
    return labels === '' && explicitName(element) === '' && normalise(element.getAttribute('placeholder')) === '';
  }));

  // 2.4.2 Document has a title.
  if (normalise(document.title) === '') add('document-title', [document.documentElement]);

  // 3.1.1 Page has a lang attribute; 3.1.1 and 3.1.2 lang values are valid.
  const root = document.documentElement;
  if (normalise(root.getAttribute('lang')) === '' && normalise(root.getAttribute('xml:lang')) === '') add('html-has-lang', [root]);
  const languageNames = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
  const validLanguage = (tag: string): boolean => {
    try {
      const canonical = Intl.getCanonicalLocales(tag)[0] ?? '';
      const primary = canonical.split('-')[0] ?? '';
      return primary.length >= 2 && primary.length <= 3 && languageNames.of(primary) !== undefined;
    } catch { return false; }
  };
  if (normalise(root.getAttribute('lang')) !== '' && !validLanguage(normalise(root.getAttribute('lang')))) add('html-lang-valid', [root]);
  add('valid-lang', shown('body [lang]').filter((element) => normalise(element.getAttribute('lang')) !== '' && !validLanguage(normalise(element.getAttribute('lang')))));

  // 1.3.1 Lists contain only list items.
  add('list', shown('ul, ol').filter((element) => element.getAttribute('role') === null
    && Array.from(element.children).some((child) => !['LI', 'SCRIPT', 'TEMPLATE'].includes(child.tagName))));

  // 1.3.5 Autocomplete attribute has a valid value.
  const autofillFields = ['name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name', 'honorific-suffix', 'nickname',
    'username', 'new-password', 'current-password', 'one-time-code', 'organization-title', 'organization', 'street-address',
    'address-line1', 'address-line2', 'address-line3', 'address-level4', 'address-level3', 'address-level2', 'address-level1',
    'country', 'country-name', 'postal-code', 'cc-name', 'cc-given-name', 'cc-additional-name', 'cc-family-name', 'cc-number',
    'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type', 'transaction-currency', 'transaction-amount', 'language',
    'bday', 'bday-day', 'bday-month', 'bday-year', 'sex', 'url', 'photo', 'tel', 'tel-country-code', 'tel-national',
    'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension', 'email', 'impp'];
  const contactFields = ['tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension', 'email', 'impp'];
  const validAutocomplete = (value: string): boolean => {
    const tokens = value.toLowerCase().split(/\s+/).filter((token) => token !== '');
    if (tokens.length === 0 || (tokens.length === 1 && (tokens[0] === 'on' || tokens[0] === 'off'))) return true;
    if (tokens[tokens.length - 1] === 'webauthn') tokens.pop();
    const field = tokens.pop() ?? '';
    if (!autofillFields.includes(field)) return false;
    if (tokens.length > 0 && ['home', 'work', 'mobile', 'fax', 'pager'].includes(tokens[tokens.length - 1] ?? '')) {
      if (!contactFields.includes(field)) return false;
      tokens.pop();
    }
    if (tokens.length > 0 && ['shipping', 'billing'].includes(tokens[tokens.length - 1] ?? '')) tokens.pop();
    if (tokens.length > 0 && (tokens[tokens.length - 1] ?? '').startsWith('section-')) tokens.pop();
    return tokens.length === 0;
  };
  add('autocomplete-valid', shown('input[autocomplete], select[autocomplete], textarea[autocomplete]')
    .filter((element) => !validAutocomplete(element.getAttribute('autocomplete') ?? '')));

  // 1.4.3 Text has enough contrast. Solid backgrounds only; images and gradients are skipped as undecidable.
  type Colour = [number, number, number, number];
  const parseColour = (text: string): Colour | null => {
    const match = /rgba?\(([^)]+)\)/.exec(text);
    if (match === null || match[1] === undefined) return null;
    const channels = match[1].split(/[\s,/]+/).filter((part) => part !== '').map(Number);
    return [channels[0] ?? 0, channels[1] ?? 0, channels[2] ?? 0, channels[3] ?? 1];
  };
  const over = (top: Colour, under: Colour): Colour => {
    const alpha = top[3] + under[3] * (1 - top[3]);
    if (alpha === 0) return [0, 0, 0, 0];
    const mix = (channel: 0 | 1 | 2): number => (top[channel] * top[3] + under[channel] * under[3] * (1 - top[3])) / alpha;
    return [mix(0), mix(1), mix(2), alpha];
  };
  const background = (element: Element): Colour | null => {
    const layers: Colour[] = [];
    for (let current: Element | null = element; current !== null; current = current.parentElement) {
      const style = getComputedStyle(current);
      if (style.backgroundImage !== 'none') return null;
      const colour = parseColour(style.backgroundColor);
      if (colour !== null && colour[3] > 0) { layers.push(colour); if (colour[3] >= 1) break; }
    }
    let combined: Colour = [255, 255, 255, 1];
    for (const layer of layers.reverse()) combined = over(layer, combined);
    return combined;
  };
  const luminance = (colour: Colour): number => {
    const linear = (value: number): number => { const scaled = value / 255; return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * linear(colour[0]) + 0.7152 * linear(colour[1]) + 0.0722 * linear(colour[2]);
  };
  add('color-contrast', shown('body *').filter((element) => {
    if (['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'OPTION'].includes(element.tagName)) return false;
    if ((element as HTMLButtonElement).disabled === true) return false;
    const ownText = Array.from(element.childNodes).some((child) => child.nodeType === Node.TEXT_NODE && normalise(child.textContent) !== '');
    if (!ownText) return false;
    const style = getComputedStyle(element);
    const backgroundColour = background(element);
    const rawForeground = parseColour(style.color);
    if (backgroundColour === null || rawForeground === null) return false;
    const foreground = over(rawForeground, backgroundColour);
    const [lighter, darker] = [luminance(foreground), luminance(backgroundColour)].sort((left, right) => right - left) as [number, number];
    const ratio = (lighter + 0.05) / (darker + 0.05);
    const size = parseFloat(style.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
    return ratio < (large ? 3 : 4.5);
  }));

  // 1.4.4 Zoom is not disabled.
  add('meta-viewport', Array.from(document.querySelectorAll('meta[name="viewport"]')).filter((meta) => {
    const content = (meta.getAttribute('content') ?? '').toLowerCase().replace(/\s+/g, '');
    const notScalable = /user-scalable=(no|0)(,|;|$)/.test(content);
    const largestScale = /maximum-scale=([\d.]+)/.exec(content);
    return notScalable || (largestScale !== null && Number(largestScale[1]) < 2);
  }));

  // 2.2.1 No timed refresh.
  add('meta-refresh', Array.from(document.querySelectorAll('meta[http-equiv="refresh" i]')).filter((meta) => {
    const delay = Number.parseFloat(meta.getAttribute('content') ?? '');
    return Number.isFinite(delay) && delay > 0 && delay <= 72000;
  }));

  // 2.2.2 No marquee.
  add('marquee', Array.from(document.querySelectorAll('marquee')));

  // 4.1.2 Role attribute has a valid value.
  const roles = ['alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox',
    'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'document', 'emphasis',
    'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'image', 'insertion', 'link', 'list', 'listbox',
    'listitem', 'log', 'main', 'mark', 'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'meter',
    'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region', 'row',
    'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript',
    'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree',
    'treegrid', 'treeitem', 'graphics-document', 'graphics-object', 'graphics-symbol'];
  add('aria-roles', shown('[role]').filter((element) => {
    const tokens = (element.getAttribute('role') ?? '').toLowerCase().split(/\s+/).filter((token) => token !== '');
    return tokens.length > 0 && !tokens.some((token) => roles.includes(token));
  }));

  return JSON.stringify(rules);
}
