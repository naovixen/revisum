// ACT rules decided from the page snapshot. Each follows the W3C ACT rule text named in its
// meta.source; the pinned copies are in fixtures/act-test-cases/rules/<id>.html.
import type { InteractiveRule, PageSnapshot, SnapshotNode, StaticRule, TargetResult } from '../accessibility-types.ts';
import { snapshotExtras } from '../page-snapshot.ts';
import {
  ancestors, descendants, explicitRole, inAccessibilityTree, inSvg, isVisible, parentElement, parseColour, programmaticallyHidden, textVisible,
} from '../snapshot-queries.ts';
import {
  ARIA_ROLES, WIDGET_ROLES, accessibilityRole, actRuleMeta, actuallyDisabled, hasKnownPrimaryLanguage, implicitRole, inSequentialFocus,
  inert, parseStyleAttribute, pixels, presentational,
} from './rule-predicates.ts';

const elementsOf = (snapshot: PageSnapshot): SnapshotNode[] => snapshot.nodes.filter((node) => node.nodeType === 1);
const passed = (node: SnapshotNode, message = ''): TargetResult => ({ node: node.index, outcome: 'passed', message });
const failed = (node: SnapshotNode, message: string): TargetResult => ({ node: node.index, outcome: 'failed', message });
const cantTell = (node: SnapshotNode, message: string): TargetResult => ({ node: node.index, outcome: 'cantTell', message });
const isHtmlElement = (snapshot: PageSnapshot, node: SnapshotNode): boolean => !inSvg(snapshot, node) && node.name !== 'svg' && node.name !== 'math';
const inShadowTree = (snapshot: PageSnapshot, node: SnapshotNode): boolean => snapshotExtras(snapshot).inShadow.has(node.index);
const topHtmlRoot = (snapshot: PageSnapshot): SnapshotNode | undefined => {
  const documentNode = snapshot.nodes.find((node) => node.nodeType === 9 && node.document === 0);
  return documentNode ? documentNode.children.map((childIndex) => snapshot.nodes[childIndex]).find((child) => child?.nodeType === 1) : undefined;
};
const nameOf = (node: SnapshotNode): string => node.accessibility?.name ?? '';
const typeAttribute = (node: SnapshotNode): string => (node.attributes['type'] ?? '').toLowerCase();

// ACT 23a2a8: image has non-empty accessible name.
const imageNameRule: StaticRule = {
  meta: actRuleMeta('23a2a8', 'Image has non-empty accessible name', ['1.1.1'], 'P2', false),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      if (!isHtmlElement(snapshot, node)) continue;
      const semanticImage = accessibilityRole(node) === 'img' || (node.accessibility === null && explicitRole(node) === 'img');
      if (node.name !== 'img' && !semanticImage) continue;
      if (programmaticallyHidden(snapshot, node)) continue;
      const role = node.accessibility ? accessibilityRole(node) : '';
      const decorative = presentational(snapshot, node) || role === 'none' || role === 'presentation'
        || (node.name === 'img' && node.attributes['alt'] === '' && (node.accessibility === null || node.accessibility.ignored));
      if (decorative) { results.push(passed(node, 'decorative')); continue; }
      if (node.accessibility && node.accessibility.name.trim() !== '') results.push(passed(node));
      else results.push(failed(node, 'Image has no accessible name'));
    }
    return results;
  },
};

// ACT 59796f: image button has non-empty accessible name.
const imageButtonNameRule: StaticRule = {
  meta: actRuleMeta('59796f', 'Image button has non-empty accessible name', ['1.1.1', '4.1.2'], 'P1', false),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      if (node.name !== 'input' || typeAttribute(node) !== 'image' || !inAccessibilityTree(node)) continue;
      const name = nameOf(node).trim();
      if (name === '' || /^submit( query)?$/i.test(name)) results.push(failed(node, 'Image button has no accessible name other than the default'));
      else results.push(passed(node));
    }
    return results;
  },
};

// ACT 97a4e1: button has non-empty accessible name.
const buttonNameRule: StaticRule = {
  meta: actRuleMeta('97a4e1', 'Button has non-empty accessible name', ['4.1.2'], 'P1', false),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      if (!inAccessibilityTree(node) || accessibilityRole(node) !== 'button') continue;
      if (node.name === 'input' && typeAttribute(node) === 'image') continue;
      if (nameOf(node).trim() === '' && nameOf(node) === '') results.push(failed(node, 'Button has no accessible name'));
      else results.push(passed(node));
    }
    return results;
  },
};

// ACT c487ae: link has non-empty accessible name.
const LINK_ROLES = new Set(['link', 'doc-backlink', 'doc-biblioref', 'doc-glossref', 'doc-noteref']);
const linkNameRule: StaticRule = {
  meta: actRuleMeta('c487ae', 'Link has non-empty accessible name', ['2.4.4', '4.1.2'], 'P1', false),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      if (!inAccessibilityTree(node)) continue;
      const explicit = explicitRole(node);
      if (!(accessibilityRole(node) === 'link' || (explicit !== null && LINK_ROLES.has(explicit)))) continue;
      if (nameOf(node) === '') results.push(failed(node, 'Link has no accessible name'));
      else results.push(passed(node));
    }
    return results;
  },
};

// ACT e086e5: form field has non-empty accessible name.
const FIELD_ROLES = new Set(['checkbox', 'combobox', 'listbox', 'menuitemcheckbox', 'menuitemradio', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'textbox']);
const FIELD_INPUT_TYPES = new Set(['color', 'date', 'datetime-local', 'file', 'month', 'password', 'time', 'week']);
const formFieldNameRule: StaticRule = {
  meta: actRuleMeta('e086e5', 'Form field has non-empty accessible name', ['4.1.2'], 'P1'),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      if (!inAccessibilityTree(node)) continue;
      const explicit = explicitRole(node);
      const role = explicit !== null && ARIA_ROLES.has(explicit) ? explicit : accessibilityRole(node);
      const typedField = node.name === 'input' && explicit === null && FIELD_INPUT_TYPES.has(typeAttribute(node));
      if (!FIELD_ROLES.has(role) && !typedField) continue;
      if (nameOf(node) === '') results.push(failed(node, 'Form field has no accessible name'));
      else results.push(passed(node));
    }
    return results;
  },
};

// ACT 674b10: role attribute has valid value.
const validRoleRule: StaticRule = {
  meta: actRuleMeta('674b10', 'Role attribute has valid value', ['4.1.2', '1.3.1'], 'P2'),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      const role = node.attributes['role'];
      if (role === undefined || role.trim() === '') continue;
      if (programmaticallyHidden(snapshot, node)) continue;
      const tokens = role.trim().toLowerCase().split(/\s+/);
      if (tokens.some((token) => ARIA_ROLES.has(token))) results.push(passed(node));
      else results.push(failed(node, `No valid WAI-ARIA role in "${role}"`));
    }
    return results;
  },
};

// ACT 6cfa84: element with aria-hidden has no content in sequential focus navigation. ACT
// "focusable" leaves out elements that do not keep focus (they move it away within a second),
// so each candidate is focused to check.
export const ariaHiddenFocusRule: InteractiveRule = {
  meta: actRuleMeta('6cfa84', 'Element with aria-hidden has no content in sequential focus navigation', ['4.1.2'], 'P1', false),
  needsWalk: false,
  async run(page, snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      if (node.attributes['aria-hidden'] !== 'true') continue;
      const candidates = [node, ...descendants(snapshot, node)].filter((candidate) => candidate.nodeType === 1 && inSequentialFocus(snapshot, candidate));
      const keptFocus: SnapshotNode[] = [];
      for (const candidate of candidates) if (await page.focusBackend(candidate.backendId)) keptFocus.push(candidate);
      if (keptFocus.length) results.push(failed(node, `aria-hidden content contains ${keptFocus.length} element(s) in the tab order`));
      else results.push(passed(node));
    }
    return results;
  },
};

// ACT bc4a75: ARIA required owned elements, from the WAI-ARIA 1.2 role definitions.
const REQUIRED_OWNED: Record<string, string[]> = {
  feed: ['article'], grid: ['row', 'rowgroup>row'], list: ['listitem'], listbox: ['group>option', 'option'],
  menu: ['group>menuitem', 'group>menuitemradio', 'group>menuitemcheckbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio'],
  menubar: ['group>menuitem', 'group>menuitemradio', 'group>menuitemcheckbox', 'menuitem', 'menuitemcheckbox', 'menuitemradio'],
  row: ['cell', 'columnheader', 'gridcell', 'rowheader'], rowgroup: ['row'], table: ['row', 'rowgroup>row'], tablist: ['tab'],
  tree: ['group>treeitem', 'treeitem'], treegrid: ['row', 'rowgroup>row'],
};
function semanticRole(node: SnapshotNode, snapshot?: PageSnapshot): string {
  const explicit = explicitRole(node);
  const explicitRoleHolds = !(snapshot && (explicit === 'none' || explicit === 'presentation') && !presentational(snapshot, node));
  if (explicit !== null && ARIA_ROLES.has(explicit) && explicitRoleHolds) return explicit;
  return (snapshot ? implicitRole(snapshot, node) : null) ?? accessibilityRole(node);
}
function ownedElements(snapshot: PageSnapshot, owner: SnapshotNode): SnapshotNode[] {
  const owned: SnapshotNode[] = [];
  const visit = (parent: SnapshotNode): void => {
    for (const childIndex of parent.children) {
      const child = snapshot.nodes[childIndex];
      if (!child) continue;
      if (child.nodeType === 11) { visit(child); continue; }
      if (child.nodeType !== 1 || child.name.startsWith('::')) continue;
      const skipped = (child.style === null && !['option', 'optgroup'].includes(child.name)) || child.attributes['aria-hidden'] === 'true'
        || ['br', 'wbr', 'script', 'style', 'template', 'slot'].includes(child.name);
      if (skipped) { if (child.name === 'slot') visit(child); continue; }
      if (presentational(snapshot, child)) { visit(child); continue; }
      owned.push(child);
    }
  };
  visit(owner);
  // Kept exactly as the rule was scored: the id list is split on the letter "s" (pattern /s+/), not on white space.
  for (const id of (owner.attributes['aria-owns'] ?? '').split(/s+/).filter(Boolean)) {
    const target = snapshot.nodes.find((node) => node.nodeType === 1 && node.document === owner.document && node.attributes['id'] === id);
    if (target && !owned.includes(target)) owned.push(target);
  }
  return owned;
}
const requiredOwnedRule: StaticRule = {
  meta: actRuleMeta('bc4a75', 'ARIA required owned elements', ['1.3.1'], 'P2'),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      if (!inAccessibilityTree(node) && !(node.accessibility && node.style)) continue;
      if (programmaticallyHidden(snapshot, node)) continue;
      const role = semanticRole(node, snapshot);
      const required = REQUIRED_OWNED[role];
      if (!required) continue;
      if ([node, ...ancestors(snapshot, node)].some((ancestor) => inAccessibilityTree(ancestor) && ancestor.attributes['aria-busy'] === 'true')) continue;
      const owned = ownedElements(snapshot, node);
      const disallowed = (list: SnapshotNode[], allowed: string[]): SnapshotNode[] => list.filter((child) => {
        const childRole = semanticRole(child, snapshot);
        if (allowed.includes(childRole)) return false;
        const nested = allowed.filter((entry) => entry.startsWith(childRole + '>')).map((entry) => entry.split('>')[1] ?? '');
        if (nested.length === 0) return true;
        // A group may own the nested roles, or further groups.
        return disallowed(ownedElements(snapshot, child), [...nested, ...nested.map((entry) => childRole + '>' + entry)]).length > 0;
      });
      const wrong = disallowed(owned, required);
      if (wrong.length) results.push(failed(node, `${role} owns ${wrong.map((child) => semanticRole(child, snapshot) || child.name).join(', ')}`));
      else results.push(passed(node));
    }
    return results;
  },
};

// ACT 2779a5: HTML page has non-empty title.
const pageTitleRule: StaticRule = {
  meta: actRuleMeta('2779a5', 'HTML page has non-empty title', ['2.4.2'], 'P3'),
  evaluate(snapshot) {
    const root = topHtmlRoot(snapshot);
    if (!root || root.name !== 'html') return [];
    const title = descendants(snapshot, root).find((descendant) => descendant.nodeType === 1 && descendant.name === 'title'
      && !inSvg(snapshot, descendant) && descendant.document === root.document && !inShadowTree(snapshot, descendant));
    if (!title) return [failed(root, 'Page has no title element')];
    const text = title.children.map((childIndex) => snapshot.nodes[childIndex]).filter((child) => child?.nodeType === 3).map((child) => child?.value ?? '').join('');
    return [text.trim() === '' ? failed(root, 'Page title is empty') : passed(root)];
  },
};

// ACT b5c3f8: HTML page has lang attribute.
const pageLanguageRule: StaticRule = {
  meta: actRuleMeta('b5c3f8', 'HTML page has lang attribute', ['3.1.1'], 'P3', false),
  evaluate(snapshot) {
    const root = topHtmlRoot(snapshot);
    if (!root || root.name !== 'html' || snapshotExtras(snapshot).contentType !== 'text/html') return [];
    const language = root.attributes['lang'];
    return [language === undefined || language.trim() === '' ? failed(root, 'Page has no lang attribute') : passed(root)];
  },
};

// ACT bf051a: HTML page lang attribute has valid language tag.
const pageLanguageValidRule: StaticRule = {
  meta: actRuleMeta('bf051a', 'HTML page lang attribute has valid language tag', ['3.1.1'], 'P3', false),
  evaluate(snapshot) {
    const root = topHtmlRoot(snapshot);
    if (!root || root.name !== 'html' || snapshotExtras(snapshot).contentType !== 'text/html') return [];
    const language = root.attributes['lang'];
    if (language === undefined || language.trim() === '') return [];
    return [hasKnownPrimaryLanguage(language) ? passed(root) : failed(root, `Unknown primary language in lang="${language}"`)];
  },
};

// ACT de46e4: element with lang attribute has valid language tag.
function languageOwner(snapshot: PageSnapshot, node: SnapshotNode): SnapshotNode | undefined {
  let parent = parentElement(snapshot, node);
  while (parent) {
    if (parent.attributes['lang'] !== undefined) return parent;
    parent = parentElement(snapshot, parent);
  }
  return undefined;
}
const NAMING_ATTRIBUTES = ['alt', 'aria-label', 'title'];
const elementLanguageRule: StaticRule = {
  meta: actRuleMeta('de46e4', 'Element with lang attribute has valid language tag', ['3.1.2'], 'P3', false),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      const language = node.attributes['lang'];
      if (language === undefined || language === '' || !isHtmlElement(snapshot, node)) continue;
      if (!ancestors(snapshot, node).some((ancestor) => ancestor.name === 'body') && node.name !== 'body') continue;
      // Text that inherits the language: visible text or text in the accessibility tree (text nodes, or alt, aria-label or title on elements).
      const inheriting = descendants(snapshot, node).filter((descendant) => {
        if (descendant.nodeType === 3) {
          const parentNode = descendant.parent >= 0 ? (snapshot.nodes[descendant.parent] as SnapshotNode) : descendant;
          return descendant.value.trim() !== '' && languageOwner(snapshot, descendant) === node
            && (textVisible(snapshot, descendant) || (parentElement(snapshot, descendant)?.accessibility !== null && !programmaticallyHidden(snapshot, parentNode)));
        }
        if (descendant.nodeType === 1) {
          return descendant.attributes['lang'] === undefined && languageOwner(snapshot, descendant) === node && inAccessibilityTree(descendant)
            && NAMING_ATTRIBUTES.some((attribute) => (descendant.attributes[attribute] ?? '').trim() !== '');
        }
        return false;
      });
      const namedItself = NAMING_ATTRIBUTES.some((attribute) => (node.attributes[attribute] ?? '').trim() !== '') && inAccessibilityTree(node);
      if (inheriting.length === 0 && !namedItself) continue;
      results.push(hasKnownPrimaryLanguage(language) ? passed(node) : failed(node, `Unknown primary language in lang="${language}"`));
    }
    return results;
  },
};

// ACT 73f2c2: autocomplete attribute has valid value (the HTML Standard's autofill detail tokens).
const AUTOFILL_FIELDS = new Set(['name', 'honorific-prefix', 'given-name', 'additional-name', 'family-name', 'honorific-suffix', 'nickname', 'username',
  'new-password', 'current-password', 'one-time-code', 'organization-title', 'organization', 'street-address', 'address-line1', 'address-line2',
  'address-line3', 'address-level4', 'address-level3', 'address-level2', 'address-level1', 'country', 'country-name', 'postal-code', 'cc-name',
  'cc-given-name', 'cc-additional-name', 'cc-family-name', 'cc-number', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'cc-csc', 'cc-type',
  'transaction-currency', 'transaction-amount', 'language', 'bday', 'bday-day', 'bday-month', 'bday-year', 'sex', 'url', 'photo']);
const AUTOFILL_CONTACT_FIELDS = new Set(['tel', 'tel-country-code', 'tel-national', 'tel-area-code', 'tel-local', 'tel-local-prefix', 'tel-local-suffix', 'tel-extension', 'email', 'impp']);
function validAutocomplete(value: string): boolean {
  const tokens = value.trim().toLowerCase().split(/\s+/);
  let position = 0;
  if (tokens[position]?.startsWith('section-')) position++;
  if (tokens[position] === 'shipping' || tokens[position] === 'billing') position++;
  if (['home', 'work', 'mobile', 'fax', 'pager'].includes(tokens[position] ?? '')) {
    position++;
    if (!AUTOFILL_CONTACT_FIELDS.has(tokens[position] ?? '')) return false;
    position++;
  } else if (AUTOFILL_FIELDS.has(tokens[position] ?? '') || AUTOFILL_CONTACT_FIELDS.has(tokens[position] ?? '')) position++;
  else return false;
  if (tokens[position] === 'webauthn') position++;
  return position === tokens.length;
}
const FIXED_INPUT_TYPES = new Set(['button', 'checkbox', 'file', 'image', 'radio', 'reset', 'submit']);
const autocompleteRule: StaticRule = {
  meta: actRuleMeta('73f2c2', 'autocomplete attribute has valid value', ['1.3.5'], 'P3'),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      if (!['input', 'select', 'textarea'].includes(node.name)) continue;
      const value = node.attributes['autocomplete'];
      if (value === undefined || value.trim() === '') continue;
      const tokens = value.trim().split(/\s+/);
      if (tokens.length === 1 && /^(on|off)$/i.test(tokens[0] ?? '')) continue;
      if (actuallyDisabled(snapshot, node) || node.attributes['aria-disabled'] === 'true') continue;
      if (node.name === 'input' && FIXED_INPUT_TYPES.has(typeAttribute(node))) continue;
      if (!isVisible(snapshot, node) && !inAccessibilityTree(node)) continue;
      const role = explicitRole(node) ?? accessibilityRole(node);
      if (!inSequentialFocus(snapshot, node) && !WIDGET_ROLES.has(role)) continue;
      results.push(validAutocomplete(value) ? passed(node) : failed(node, `Invalid autocomplete value "${value}"`));
    }
    return results;
  },
};

// ACT afw4f7: text has minimum contrast.
type Rgb = [number, number, number];
type Rgba = [number, number, number, number];
const relativeLuminance = ([red, green, blue]: Rgb): number => {
  const linear = (channel: number): number => {
    const scaled = channel / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : Math.pow((scaled + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue);
};
export const contrastRatio = (first: Rgb, second: Rgb): number => {
  const firstLuminance = relativeLuminance(first);
  const secondLuminance = relativeLuminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05) / (Math.min(firstLuminance, secondLuminance) + 0.05);
};
const blend = (foreground: Rgba, background: Rgb): Rgb =>
  [0, 1, 2].map((channel) => (foreground[channel] ?? 0) * foreground[3] + (background[channel] ?? 0) * (1 - foreground[3])) as Rgb;
const ROLES_THAT_PASS_ON_DISABLED = new Set(['button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox', 'treeitem', 'group', 'radiogroup',
  'menu', 'menubar', 'tablist', 'toolbar', 'tree', 'grid', 'treegrid', 'row', 'rowgroup', 'listitem']);
function hasDisabledAncestor(snapshot: PageSnapshot, text: SnapshotNode): boolean {
  for (const ancestor of ancestors(snapshot, text)) {
    if (actuallyDisabled(snapshot, ancestor)) return true;
    if (ancestor.attributes['aria-disabled'] === 'true' && ROLES_THAT_PASS_ON_DISABLED.has(explicitRole(ancestor) ?? accessibilityRole(ancestor))) return true;
    if (ancestor.accessibility?.properties['disabled'] === true) return true;
    if (ancestor.name === 'label') {
      const forId = ancestor.attributes['for'];
      const control = forId
        ? snapshot.nodes.find((node) => node.document === ancestor.document && node.attributes['id'] === forId)
        : descendants(snapshot, ancestor).find((descendant) => ['input', 'select', 'textarea', 'button'].includes(descendant.name));
      if (control && (actuallyDisabled(snapshot, control) || control.attributes['aria-disabled'] === 'true')) return true;
    }
    const labelling = snapshot.nodes.filter((node) => node.document === ancestor.document && node.nodeType === 1
      && (node.attributes['aria-labelledby'] ?? '').split(/\s+/).includes(ancestor.attributes['id'] ?? '\u0000'));
    if (labelling.some((node) => actuallyDisabled(snapshot, node) || node.attributes['aria-disabled'] === 'true')) return true;
  }
  return false;
}
interface TextShadow { colour: Rgba; blur: number }
function parseTextShadows(value: string | undefined): TextShadow[] {
  if (!value || value === 'none') return [];
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of value) {
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (character === ',' && depth === 0) { parts.push(current); current = ''; } else current += character;
  }
  parts.push(current);
  const shadows: TextShadow[] = [];
  for (const part of parts) {
    const colour = parseColour(part);
    if (!colour) continue;
    const lengths = part.replace(/rgba?\([^)]*\)/, '').trim().split(/\s+/).map((length) => pixels(length)).filter((length) => !Number.isNaN(length));
    shadows.push({ colour, blur: lengths[2] ?? 0 });
  }
  return shadows;
}
const HUMAN_LANGUAGE_TEXT = /[\p{L}\p{N}]/u;
const rgbOf = (colour: Rgba): Rgb => [colour[0], colour[1], colour[2]];
// Solid backgrounds are decided from the snapshot; text over images or gradients from rendered pixels.
export const textContrastRule: InteractiveRule = {
  meta: actRuleMeta('afw4f7', 'Text has minimum contrast', ['1.4.3'], 'P2'),
  needsWalk: false,
  async run(page, snapshot) {
    const results: TargetResult[] = [];
    const extras = snapshotExtras(snapshot);
    for (const text of snapshot.nodes) {
      if (text.nodeType !== 3 || !textVisible(snapshot, text)) continue;
      const parent = parentElement(snapshot, text);
      if (!parent || !parent.style || !isHtmlElement(snapshot, parent)) continue;
      if (hasDisabledAncestor(snapshot, text)) continue;
      if (parent.style['text-indent'] && pixels(parent.style['text-indent']) < -999) continue; // moved off screen
      if (!HUMAN_LANGUAGE_TEXT.test(text.value)) { results.push(passed(parent, 'Text does not express anything in human language')); continue; }
      const textColour = parseColour(parent.style['color']);
      if (!textColour) { results.push(cantTell(parent, 'Unparsed text colour')); continue; }
      const opacity = extras.textOpacity.get(parent.index) ?? extras.textOpacity.get(text.index) ?? 1;
      const foreground: Rgba = [textColour[0], textColour[1], textColour[2], textColour[3] * opacity];
      const shadows = parseTextShadows(parent.style['text-shadow']).filter((shadow) => shadow.colour[3] > 0);
      const halo = shadows.some((shadow) => shadow.blur >= 1);
      let imageBackground = false;
      for (const ancestor of [parent, ...ancestors(snapshot, parent)]) {
        if ((ancestor.style?.['background-image'] ?? 'none') !== 'none') { imageBackground = true; break; }
        const backgroundColour = parseColour(ancestor.style?.['background-color']);
        if (backgroundColour && backgroundColour[3] === 1) break;
      }
      const blended = parseColour(extras.blendedBackground.get(parent.index) ?? extras.blendedBackground.get(text.index) ?? 'rgb(255, 255, 255)');
      const solid: Rgb = blended ? rgbOf(blended) : [255, 255, 255];
      // Background colours next to the glyphs: a blurred shadow (halo) replaces the element background around the strokes.
      let candidates: Rgb[];
      let method = 'solid background';
      if (halo) {
        candidates = shadows.map((shadow) => rgbOf(shadow.colour));
        method = 'text-shadow halo';
      } else if (imageBackground) {
        const sampled = await page.sampleBackground(text.backendId);
        if (!sampled) { results.push(cantTell(parent, 'Text over a background image or gradient; pixels not readable')); continue; }
        candidates = [sampled.dark, sampled.light, ...shadows.map((shadow) => rgbOf(shadow.colour))];
        method = 'rendered background pixels';
      } else {
        candidates = [solid, ...shadows.map((shadow) => rgbOf(shadow.colour))];
      }
      const ratio = Math.max(...candidates.map((background) => contrastRatio(blend(foreground, background), background)));
      const size = pixels(parent.style['font-size']);
      const weight = Number(parent.style['font-weight'] ?? '400');
      const large = size >= 24 || (size >= 18.66 && weight >= 700);
      const required = large ? 3 : 4.5;
      if (!halo && !imageBackground && ratio <= 1.0001) continue; // the same colour: not a visual presentation of text (rule assumption)
      results.push(ratio + 1e-9 >= required ? passed(parent) : failed(parent, `Highest possible contrast ${ratio.toFixed(2)}:1 (${method}) is below ${required}:1`));
    }
    return results;
  },
};

// ACT b4f0c3: meta viewport allows for zoom.
function viewportSettings(content: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const part of content.split(/[,;]/)) {
    const [key, value] = part.split('=').map((piece) => piece.trim().toLowerCase());
    if (key) settings.set(key, value ?? '');
  }
  return settings;
}
const leadingNumber = (value: string): number => {
  const match = value.match(/^[+-]?(\d+\.?\d*|\.\d+)/);
  return match ? Number(match[0]) : NaN;
};
const viewportZoomRule: StaticRule = {
  meta: actRuleMeta('b4f0c3', 'Meta viewport allows for zoom', ['1.4.4', '1.4.10'], 'P2'),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      if (node.name !== 'meta' || (node.attributes['name'] ?? '').toLowerCase() !== 'viewport' || node.attributes['content'] === undefined) continue;
      const settings = viewportSettings(node.attributes['content'] ?? '');
      if (!settings.has('maximum-scale') && !settings.has('user-scalable')) continue;
      let allowsZoom = true;
      const reasons: string[] = [];
      const userScalable = settings.get('user-scalable');
      if (userScalable !== undefined) {
        const number = leadingNumber(userScalable);
        const good = userScalable === 'yes' || userScalable === 'device-width' || userScalable === 'device-height'
          || (!Number.isNaN(number) && (number <= -1 || number >= 1));
        if (!good) { allowsZoom = false; reasons.push(`user-scalable=${userScalable}`); }
      }
      const largestScale = settings.get('maximum-scale');
      if (largestScale !== undefined) {
        const number = leadingNumber(largestScale);
        const good = largestScale === 'device-width' || largestScale === 'device-height' || (!Number.isNaN(number) && (number < 0 || number >= 2));
        if (!good) { allowsZoom = false; reasons.push(`maximum-scale=${largestScale}`); }
      }
      results.push(allowsZoom ? passed(node) : failed(node, `Viewport blocks zoom (${reasons.join(', ')})`));
    }
    return results;
  },
};

// ACT 24afc2, 9e45ec and 78fd32: important text spacing set in style attributes.
// True when the element's value for the property comes, directly or by inheritance, from an
// important declaration in a style attribute.
function importantFromStyleAttribute(snapshot: PageSnapshot, node: SnapshotNode, property: string): boolean {
  let current: SnapshotNode | undefined = node;
  while (current && current.nodeType === 1) {
    const declarations = parseStyleAttribute(current.attributes['style']).filter((declaration) => declaration.property === property);
    const important = declarations.filter((declaration) => declaration.important);
    const winner = important.length ? important[important.length - 1] : declarations[declarations.length - 1];
    const parent = parentElement(snapshot, current);
    if (winner) {
      const value = winner.value.toLowerCase();
      if (value !== 'inherit' && value !== 'unset') return winner.important;
      current = parent;
      continue; // inherit or unset (an inherited property): the value comes from the parent
    }
    // No declaration in the style attribute: inherited only if the computed value equals the parent's.
    if (!parent || !parent.style || !current.style || parent.style[property] !== current.style[property]) return false;
    current = parent;
  }
  return false;
}
function textSpacingRule(id: string, title: string, property: 'letter-spacing' | 'word-spacing' | 'line-height', factor: number): StaticRule {
  return {
    meta: actRuleMeta(id, title, ['1.4.12'], 'P3'),
    evaluate(snapshot) {
      const results: TargetResult[] = [];
      for (const node of elementsOf(snapshot)) {
        if (!isHtmlElement(snapshot, node) || !node.style) continue;
        if (!importantFromStyleAttribute(snapshot, node, property)) continue;
        const texts = node.children.map((childIndex) => snapshot.nodes[childIndex])
          .filter((child): child is SnapshotNode => child !== undefined && child.nodeType === 3 && textVisible(snapshot, child));
        if (texts.length === 0) continue;
        const fontSize = pixels(node.style['font-size']);
        let value: number;
        if (property === 'line-height') {
          const lineHeight = node.style['line-height'] ?? 'normal';
          value = lineHeight === 'normal' ? 1.2 * fontSize : pixels(lineHeight);
          // Applicable only when the text wraps: its box is taller than one line.
          const tallest = Math.max(...texts.map((text) => text.bounds?.height ?? 0));
          if (!(tallest > Math.max(value, fontSize) * 1.5)) continue;
        } else {
          const spacing = node.style[property] ?? 'normal';
          value = spacing === 'normal' ? 0 : pixels(spacing);
        }
        if (Number.isNaN(value) || Number.isNaN(fontSize)) { results.push(cantTell(node, `Unparsed ${property}`)); continue; }
        results.push(value + 1e-6 >= factor * fontSize ? passed(node) : failed(node, `${property} ${value}px is below ${factor} x font-size ${fontSize}px`));
      }
      return results;
    },
  };
}

const REPLACED_ELEMENTS = new Set(['img', 'svg', 'video', 'canvas', 'iframe', 'input', 'select', 'textarea', 'button', 'object', 'embed', 'hr', 'meter', 'progress']);
// True when the element itself paints pixels: replaced content, a background or a border.
function paints(node: SnapshotNode): boolean {
  if (REPLACED_ELEMENTS.has(node.name)) return true;
  const style = node.style;
  if (!style) return false;
  const background = parseColour(style['background-color']);
  if (background && background[3] > 0) return true;
  if ((style['background-image'] ?? 'none') !== 'none') return true;
  if ((style['border-top-style'] ?? 'none') !== 'none' && pixels(style['border-top-width']) > 0) return true;
  return false;
}
// ACT 0ssw9k: scrollable content can be reached with sequential focus navigation.
const scrollableReachRule: StaticRule = {
  meta: actRuleMeta('0ssw9k', 'Scrollable content can be reached with sequential focus navigation', ['2.1.1'], 'P2'),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    const scroll = snapshotExtras(snapshot).scroll;
    for (const node of elementsOf(snapshot)) {
      if (!node.style || !isHtmlElement(snapshot, node) || node.name === 'html' || node.name === 'body' || node.name === 'iframe') continue;
      const overflowX = node.style['overflow-x'];
      const overflowY = node.style['overflow-y'];
      const scrollsX = overflowX === 'auto' || overflowX === 'scroll';
      const scrollsY = overflowY === 'auto' || overflowY === 'scroll';
      if (!scrollsX && !scrollsY) continue;
      const sizes = scroll.get(node.index);
      if (!sizes) continue;
      const [scrollWidth, scrollHeight, clientWidth, clientHeight] = sizes;
      const horizontalOverflow = scrollWidth - clientWidth;
      const verticalOverflow = scrollHeight - clientHeight;
      const horizontalPadding = Math.max(pixels(node.style['padding-left']) || 0, pixels(node.style['padding-right']) || 0);
      const verticalPadding = Math.max(pixels(node.style['padding-top']) || 0, pixels(node.style['padding-bottom']) || 0);
      if (!((scrollsX && horizontalOverflow > horizontalPadding) || (scrollsY && verticalOverflow > verticalPadding))) continue;
      const contents = descendants(snapshot, node);
      if (!contents.some((child) => (child.nodeType === 3 && textVisible(snapshot, child)) || (child.nodeType === 1 && isVisible(snapshot, child) && paints(child)))) continue;
      if (inert(snapshot, node) || inSequentialFocus(snapshot, node) || contents.some((child) => child.nodeType === 1 && inSequentialFocus(snapshot, child))) {
        results.push(passed(node));
      } else {
        results.push(failed(node, 'Scrollable region cannot be reached with the keyboard'));
      }
    }
    return results;
  },
};

// ACT bc659a: meta element has no refresh delay.
function refreshDelay(content: string): number | null {
  // The HTML "shared declarative refresh steps": leading white space, digits with an optional fraction, then a separator or the end.
  const match = content.match(/^[\t\n\f\r ]*(\d*)(\.[\d.]*)?/);
  if (!match || (match[1] === '' && (match[2] ?? '') === '')) return null;
  const rest = content.slice(match[0].length);
  if (rest !== '' && !/^[\t\n\f\r ;,]/.test(rest)) return null;
  return match[1] === '' ? 0 : Number(match[1]);
}
const metaRefreshRule: StaticRule = {
  meta: actRuleMeta('bc659a', 'Meta element has no refresh delay', ['2.2.1'], 'P2', false),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    const documents = new Set(snapshot.nodes.map((node) => node.document));
    for (const documentIndex of documents) {
      const first = elementsOf(snapshot).find((node) => node.document === documentIndex && node.name === 'meta'
        && (node.attributes['http-equiv'] ?? '').toLowerCase() === 'refresh' && node.attributes['content'] !== undefined
        && refreshDelay(node.attributes['content'] ?? '') !== null);
      if (!first) continue;
      const delay = refreshDelay(first.attributes['content'] ?? '') ?? 0;
      results.push(delay === 0 || delay > 72000 ? passed(first) : failed(first, `Page refreshes or redirects after ${delay} s`));
    }
    return results;
  },
};

// ACT 2ee8b8: visible label is part of accessible name.
const NAME_FROM_CONTENT_ROLES = new Set(['button', 'checkbox', 'gridcell', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'switch', 'tab', 'treeitem']);
function visibleInnerText(snapshot: PageSnapshot, node: SnapshotNode): string {
  const childrenText = (): string => node.children.map((childIndex) => snapshot.nodes[childIndex])
    .filter((child): child is SnapshotNode => child !== undefined).map((child) => visibleInnerText(snapshot, child)).join('');
  if (node.nodeType === 3) {
    if (textVisible(snapshot, node)) return node.value.replace(/\s+/g, ' ');
    return node.style !== null && node.value.trim() === '' ? ' ' : (parentElement(snapshot, node)?.style && node.value.trim() === '' ? ' ' : '');
  }
  if (node.nodeType !== 1) return childrenText();
  if (!node.style) return '';
  if (!isVisible(snapshot, node) && node.name !== 'br') {
    const inner = childrenText();
    if (inner.trim() !== '') return inner; // visible descendants of a zero-size inline wrapper
    return (node.bounds?.width ?? 0) > 0 ? ' ' : '';
  }
  if (node.name === 'br') return '\n';
  const inner = childrenText();
  const display = node.style['display'] ?? 'inline';
  if (/^(block|flex|grid|list-item|table|flow-root)/.test(display) || display === 'table-caption') return '\n' + inner + '\n';
  if (display === 'table-cell' || display === 'table-row') return ' ' + inner + ' ';
  return inner;
}
function nameTokens(value: string): string[] {
  let text = value;
  let before = '';
  while (before !== text) {
    before = text;
    text = text.replace(/\([^()]*\)/g, ' ');
  }
  text = text.toLocaleLowerCase().normalize('NFKD');
  text = text.replace(/[^\p{L}\p{N}]/gu, ' ');
  const trimmed = text.trim();
  return trimmed === '' ? [] : trimmed.split(/\s+/);
}
function containsInOrder(label: string[], name: string[]): boolean {
  if (label.length === 0) return true;
  for (let i = 0; i + label.length <= name.length; i++) if (label.every((token, j) => name[i + j] === token)) return true;
  return false;
}
const labelInNameRule: StaticRule = {
  meta: actRuleMeta('2ee8b8', 'Visible label is part of accessible name', ['2.5.3'], 'P3'),
  evaluate(snapshot) {
    const results: TargetResult[] = [];
    for (const node of elementsOf(snapshot)) {
      if (!inAccessibilityTree(node)) continue;
      const explicit = explicitRole(node);
      const role = explicit !== null && ARIA_ROLES.has(explicit) ? explicit : accessibilityRole(node);
      if (!NAME_FROM_CONTENT_ROLES.has(role)) continue;
      if (node.attributes['aria-label'] === undefined && node.attributes['aria-labelledby'] === undefined) continue;
      const label = visibleInnerText(snapshot, node).replace(/\s+/g, ' ').trim();
      if (label === '') continue;
      const included = containsInOrder(nameTokens(label), nameTokens(nameOf(node)));
      results.push(included ? passed(node) : failed(node, `Visible label "${label}" is not part of the accessible name "${nameOf(node)}"`));
    }
    return results;
  },
};

export const STATIC_RULES: StaticRule[] = [
  imageNameRule, imageButtonNameRule, buttonNameRule, linkNameRule, formFieldNameRule, validRoleRule, requiredOwnedRule,
  pageTitleRule, pageLanguageRule, pageLanguageValidRule, elementLanguageRule, autocompleteRule, viewportZoomRule,
  textSpacingRule('24afc2', 'Important letter spacing in style attributes is wide enough', 'letter-spacing', 0.12),
  textSpacingRule('78fd32', 'Important line height in style attributes is wide enough', 'line-height', 1.5),
  textSpacingRule('9e45ec', 'Important word spacing in style attributes is wide enough', 'word-spacing', 0.16),
  scrollableReachRule, metaRefreshRule, labelInNameRule,
];
