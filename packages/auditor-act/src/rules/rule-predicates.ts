// Predicates the rules share, written from the ACT rules glossary and the HTML Standard rather
// than from any other engine's source.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PageSnapshot, RuleMeta, Severity, SnapshotNode } from '../accessibility-types.ts';
import { ancestors, parentElement } from '../snapshot-queries.ts';

export const ACT_RULES_BASE = 'https://www.w3.org/WAI/standards-guidelines/act/rules/';

// Metadata of a rule that follows a W3C ACT rule text. `proposed` rules live under proposed/.
export function actRuleMeta(id: string, title: string, successCriteria: string[], severity: Severity, proposed = true): RuleMeta {
  return { id, kind: 'act-rule', title, successCriteria, severity, source: `${ACT_RULES_BASE}${id}/${proposed ? 'proposed/' : ''}` };
}
// Metadata of a probe that follows a WCAG success criterion's text, for criteria without an automatable ACT rule.
export function probeMeta(id: string, title: string, successCriteria: string[], severity: Severity, source: string): RuleMeta {
  return { id, kind: 'probe', title, successCriteria, severity, source };
}

// The HTML "rules for parsing integers"; null when parsing fails.
export function parseInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = value.trim().match(/^[+-]?\d+/);
  return match ? Number(match[0]) : null;
}

export function tabIndexOf(node: SnapshotNode): number | null { return parseInteger(node.attributes['tabindex']); }

const DISABLEABLE_ELEMENTS = new Set(['button', 'input', 'select', 'textarea', 'optgroup', 'option', 'fieldset']);
// HTML "actually disabled": a disabled attribute, or a disabled fieldset ancestor outside its first legend.
export function actuallyDisabled(snapshot: PageSnapshot, node: SnapshotNode): boolean {
  if (DISABLEABLE_ELEMENTS.has(node.name) && node.attributes['disabled'] !== undefined) return true;
  if (!['button', 'input', 'select', 'textarea'].includes(node.name)) return false;
  for (const ancestor of ancestors(snapshot, node)) {
    if (ancestor.name === 'fieldset' && ancestor.attributes['disabled'] !== undefined) {
      const firstLegend = ancestor.children.map((childIndex) => snapshot.nodes[childIndex]).find((child) => child?.name === 'legend');
      if (firstLegend && (firstLegend === node || ancestors(snapshot, node).includes(firstLegend))) continue;
      return true;
    }
  }
  return false;
}

export function inert(snapshot: PageSnapshot, node: SnapshotNode): boolean {
  return node.attributes['inert'] !== undefined || ancestors(snapshot, node).some((ancestor) => ancestor.attributes['inert'] !== undefined);
}

// Rendered and not hidden by visibility: the precondition for being focusable in practice.
export function renderedForFocus(node: SnapshotNode): boolean {
  return node.style !== null && node.style['visibility'] === 'visible' && node.style['display'] !== 'none';
}

// Natively focusable, per the HTML Standard's focusable areas (the common cases).
export function nativelyFocusable(snapshot: PageSnapshot, node: SnapshotNode): boolean {
  switch (node.name) {
    case 'a': case 'area': return node.attributes['href'] !== undefined;
    case 'button': case 'select': case 'textarea': case 'iframe': return true;
    case 'input': return (node.attributes['type'] ?? '').toLowerCase() !== 'hidden';
    case 'summary': {
      const parent = parentElement(snapshot, node);
      return parent?.name === 'details' && parent.children.map((childIndex) => snapshot.nodes[childIndex]).find((child) => child?.name === 'summary') === node;
    }
    case 'audio': case 'video': return node.attributes['controls'] !== undefined;
    default: {
      const editable = node.attributes['contenteditable'];
      return editable !== undefined && editable.toLowerCase() !== 'false';
    }
  }
}

// Part of sequential focus navigation (HTML Standard), leaving out browser-only behaviours such as focusable scrollers.
export function inSequentialFocus(snapshot: PageSnapshot, node: SnapshotNode): boolean {
  if (node.nodeType !== 1 || !renderedForFocus(node) || inert(snapshot, node) || actuallyDisabled(snapshot, node)) return false;
  const tabIndex = tabIndexOf(node);
  if (tabIndex !== null) return tabIndex >= 0;
  return nativelyFocusable(snapshot, node);
}

// ACT "focusable": in sequential focus navigation, or with a tabindex value.
export function focusable(snapshot: PageSnapshot, node: SnapshotNode): boolean {
  if (node.nodeType !== 1 || !renderedForFocus(node) || inert(snapshot, node) || actuallyDisabled(snapshot, node)) return false;
  return tabIndexOf(node) !== null || nativelyFocusable(snapshot, node);
}

// The non-abstract roles of WAI-ARIA 1.2, DPUB-ARIA 1.1 and Graphics-ARIA 1.0, from the specifications' role lists.
export const ARIA_ROLES = new Set([
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox', 'code',
  'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory', 'document',
  'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img', 'insertion', 'link', 'list',
  'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'meter', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation', 'progressbar', 'radio', 'radiogroup', 'region',
  'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox', 'separator', 'slider', 'spinbutton', 'status', 'strong',
  'subscript', 'superscript', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar',
  'tooltip', 'tree', 'treegrid', 'treeitem',
  'doc-abstract', 'doc-acknowledgments', 'doc-afterword', 'doc-appendix', 'doc-backlink', 'doc-biblioentry', 'doc-bibliography',
  'doc-biblioref', 'doc-chapter', 'doc-colophon', 'doc-conclusion', 'doc-cover', 'doc-credit', 'doc-credits', 'doc-dedication',
  'doc-endnote', 'doc-endnotes', 'doc-epigraph', 'doc-epilogue', 'doc-errata', 'doc-example', 'doc-footnote', 'doc-foreword',
  'doc-glossary', 'doc-glossref', 'doc-index', 'doc-introduction', 'doc-noteref', 'doc-notice', 'doc-pagebreak', 'doc-pagefooter',
  'doc-pageheader', 'doc-pagelist', 'doc-part', 'doc-preface', 'doc-prologue', 'doc-pullquote', 'doc-qna', 'doc-subtitle',
  'doc-tip', 'doc-toc', 'graphics-document', 'graphics-object', 'graphics-symbol',
]);

// WAI-ARIA widget roles, for the "static" exceptions.
export const WIDGET_ROLES = new Set(['button', 'checkbox', 'gridcell', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
  'progressbar', 'radio', 'scrollbar', 'searchbox', 'separator', 'slider', 'spinbutton', 'switch', 'tab', 'tabpanel', 'textbox', 'treeitem',
  'combobox', 'grid', 'listbox', 'menu', 'menubar', 'radiogroup', 'tablist', 'tree', 'treegrid']);

const CHROMIUM_ROLE_NAMES: Record<string, string> = {
  image: 'img', togglebutton: 'button', popupbutton: 'button', disclosuretriangle: 'button', searchbox: 'searchbox',
  textfieldwithcombobox: 'combobox', comboboxselect: 'combobox', comboboxmenubutton: 'combobox', comboboxgrouping: 'combobox',
  menulistpopup: 'listbox', menuitemcheckbox: 'menuitemcheckbox', menuitemradio: 'menuitemradio', listboxoption: 'option',
  menulistoption: 'option', rootwebarea: 'document', statictext: 'text', layouttablecell: 'none', layouttable: 'none', layouttablerow: 'none',
  descriptionlist: 'list', descriptionlistterm: 'term', descriptionlistdetail: 'definition', figcaption: 'caption',
  labeltext: 'generic', section: 'region', sectionwithoutname: 'generic', headerasnonlandmark: 'generic', footerasnonlandmark: 'generic',
  graphicsdocument: 'graphics-document', graphicsobject: 'graphics-object', graphicssymbol: 'graphics-symbol',
};
// Chromium's accessibility role names, mapped to ARIA role names.
export function accessibilityRole(node: SnapshotNode): string {
  if (!node.accessibility) return '';
  const role = node.accessibility.role.toLowerCase();
  return CHROMIUM_ROLE_NAMES[role] ?? role;
}

// The primary language subtags of Type "language" in the IANA language subtag registry.
let knownLanguagesCache: Set<string> | null = null;
export function knownLanguages(): Set<string> {
  if (knownLanguagesCache) return knownLanguagesCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const registry = readFileSync(join(here, '..', '..', 'data', 'iana-language-subtag-registry.txt'), 'utf8');
  const languages = new Set<string>();
  for (const entry of registry.split(/\r?\n%%\r?\n/)) {
    const type = entry.match(/^Type: (\S+)/m)?.[1];
    const subtag = entry.match(/^Subtag: (\S+)/m)?.[1];
    if (type === 'language' && subtag && !subtag.includes('..')) languages.add(subtag.toLowerCase());
  }
  knownLanguagesCache = languages;
  return languages;
}
// ACT "known primary language tag": subtags are alphanumeric runs split by hyphens, and the
// primary subtag is registered as a language.
export function hasKnownPrimaryLanguage(tag: string): boolean {
  const trimmed = tag.trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/i.test(trimmed)) return false;
  const primary = trimmed.split('-')[0] ?? '';
  return knownLanguages().has(primary.toLowerCase());
}

export function parseStyleAttribute(value: string | undefined): { property: string; value: string; important: boolean }[] {
  if (!value) return [];
  const declarations: { property: string; value: string; important: boolean }[] = [];
  for (const declaration of value.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    let declared = declaration.slice(colon + 1).trim();
    const important = /!\s*important\s*$/i.test(declared);
    if (important) declared = declared.replace(/!\s*important\s*$/i, '').trim();
    declarations.push({ property, value: declared, important });
  }
  return declarations;
}

// A CSS pixel length such as "12px" as a number; NaN for anything else.
export const pixels = (value: string | undefined): number => {
  if (!value) return NaN;
  const match = value.match(/^(-?[\d.]+)px$/);
  return match ? Number(match[1]) : NaN;
};

const GLOBAL_ARIA_ATTRIBUTES = ['aria-atomic', 'aria-busy', 'aria-controls', 'aria-current', 'aria-describedby', 'aria-details', 'aria-dropeffect', 'aria-flowto',
  'aria-grabbed', 'aria-keyshortcuts', 'aria-label', 'aria-labelledby', 'aria-live', 'aria-owns', 'aria-relevant', 'aria-roledescription'];
// An explicit none or presentation role that survives WAI-ARIA presentational-role conflict resolution.
export function presentational(snapshot: PageSnapshot, node: SnapshotNode): boolean {
  const role = (node.attributes['role'] ?? '').trim().toLowerCase().split(/\s+/)[0];
  if (role !== 'none' && role !== 'presentation') return false;
  if (focusable(snapshot, node)) return false;
  return !GLOBAL_ARIA_ATTRIBUTES.some((attribute) => node.attributes[attribute] !== undefined);
}

// HTML-AAM implicit roles for the elements the ownership rules care about.
export function implicitRole(snapshot: PageSnapshot, node: SnapshotNode): string | null {
  switch (node.name) {
    case 'ul': case 'ol': case 'menu': return 'list';
    case 'li': return 'listitem';
    case 'table': return 'table';
    case 'thead': case 'tbody': case 'tfoot': return 'rowgroup';
    case 'tr': return 'row';
    case 'td': {
      const table = ancestors(snapshot, node).find((ancestor) => ancestor.name === 'table');
      const tableRole = table ? (table.attributes['role'] ?? '').trim().toLowerCase() : '';
      return tableRole === 'grid' || tableRole === 'treegrid' ? 'gridcell' : 'cell';
    }
    case 'th': return node.attributes['scope'] === 'row' ? 'rowheader' : 'columnheader';
    case 'option': return 'option';
    case 'optgroup': case 'fieldset': case 'details': return 'group';
    case 'datalist': return 'listbox';
    case 'select': return node.attributes['multiple'] !== undefined || (parseInteger(node.attributes['size']) ?? 0) > 1 ? 'listbox' : 'combobox';
    case 'article': return 'article';
    case 'div': case 'span': case 'b': case 'i': case 'u': case 'small': case 'bdi': case 'bdo': case 'data': case 'samp': case 'pre': return 'generic';
    case 'p': return 'paragraph';
    default: return null;
  }
}
