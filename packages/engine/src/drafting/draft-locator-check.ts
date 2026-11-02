// The static locator check of an explore draft: a quick look, with no browser, at whether the
// draft's locators are on the pages the crawl saw. A step is checked when it follows a `Go to`
// whose URL is on the page map's origin and whose path is in the map, up to and including the
// first step after that `Go to` that may change the page (a click, key press, selection, upload,
// download, dialog answer or page script); later steps may see another page, so they are not
// checked until the next `Go to`.
//
// Role locators match map nodes of that role whose name matches as the driver's role locator
// matches: exactly, with runs of white space folded. Label locators match form-control nodes by
// name in the same way. A map name that was cut or redacted may hide the name, so it counts as a
// possible match and never gives locator-not-on-page. Other locator kinds (text, test id, css,
// XPath), names that are run values, and steps on pages not in the map are not checked. Pure.
// See docs/specs/SPEC-37-explore-to-draft.md.
import type { DraftWarning, Locator, PageMap, PageMapNode, Plan, Step } from '@revisum/contracts';
import type { TextReading } from '../plan/readable/plan-text.ts';
import { MAXIMUM_PAGE_MAP_NAME_LENGTH } from './page-map.ts';

// Steps after which the page may no longer be the one the map shows.
const PAGE_CHANGING_STEPS: readonly Step['type'][] = ['click', 'press', 'select', 'upload', 'download', 'dialog', 'evaluate'];
// The roles a label names.
const FORM_CONTROL_ROLES: readonly string[] = [
  'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton', 'switch',
];
// What the redactor writes in place of a secret or a personal-data shape.
const REDACTED = /\[redacted:[a-z-]+\]/;
// The start of a placeholder that the 80-character cut left unfinished at the end of a name.
const UNFINISHED_PLACEHOLDER = /\[(?:r(?:e(?:d(?:a(?:c(?:t(?:e(?:d(?::[a-z-]*)?)?)?)?)?)?)?)?)?$/;

const fold = (text: string): string => text.replace(/\s+/g, ' ').trim();
const escapeForPattern = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

type Match = 'exact' | 'possible' | 'none';

// How a name the locator gives compares with a name the map holds.
function compareNames(wanted: string, held: string): Match {
  // A locator with no name matches every node of its role, as the driver's search does.
  if (wanted === '') return 'exact';
  const target = fold(wanted);
  const cut = held.length >= MAXIMUM_PAGE_MAP_NAME_LENGTH;
  const shown = fold(cut ? held.replace(UNFINISHED_PLACEHOLDER, '') : held);
  const parts = shown.split(REDACTED);
  if (parts.length === 1 && shown === target) return 'exact';
  if (parts.length === 1 && !cut) return 'none';
  // A redacted part stands for any text, and a cut name for any ending.
  const pattern = new RegExp(`^${parts.map(escapeForPattern).join('[\\s\\S]*')}${cut ? '' : '$'}`);
  return pattern.test(target) ? 'possible' : 'none';
}

const allNodes = (tree: readonly PageMapNode[]): readonly PageMapNode[] => tree.flatMap((node) => [node, ...allNodes(node.children)]);

// The warning for one locator against one page, or undefined when it may be there exactly once.
function locatorWarning(locator: Locator, tree: readonly PageMapNode[]): DraftWarning['code'] | undefined {
  let roles: readonly string[];
  let wanted: string;
  if (locator.by === 'role' && typeof locator.name === 'string') { roles = [locator.role]; wanted = locator.name; }
  else if (locator.by === 'label' && typeof locator.label === 'string') { roles = FORM_CONTROL_ROLES; wanted = locator.label; }
  else return undefined;
  let exact = 0;
  let possible = 0;
  for (const node of allNodes(tree)) {
    if (!roles.includes(node.role)) continue;
    const match = compareNames(wanted, node.name);
    if (match === 'exact') exact += 1;
    if (match === 'possible') possible += 1;
  }
  if (exact === 0 && possible === 0) return 'locator-not-on-page';
  // A position picks one of several matches, so they are not ambiguous.
  return exact > 1 && locator.position === undefined ? 'locator-ambiguous' : undefined;
}

// The map's page a navigate step opens, or undefined when it opens one the map does not hold.
function pageOpened(step: Extract<Step, { type: 'navigate' }>, map: PageMap): readonly PageMapNode[] | undefined {
  if (typeof step.url !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(step.url, map.origin);
  } catch {
    return undefined;
  }
  if (url.origin !== map.origin) return undefined;
  return map.pages.find((page) => page.path === url.pathname)?.tree;
}

export function checkDraftLocators(plan: Plan, reading: TextReading, map: PageMap): readonly DraftWarning[] {
  const warnings: DraftWarning[] = [];
  let page: readonly PageMapNode[] | undefined;
  for (const [index, step] of plan.steps.entries()) {
    if (step.type === 'navigate') { page = pageOpened(step, map); continue; }
    if (page === undefined) continue;
    if ('locator' in step) {
      const code = locatorWarning(step.locator, page);
      const position = reading.positions.get(`$.steps[${index}]`);
      if (code !== undefined && position !== undefined) warnings.push({ code, position });
    }
    if (PAGE_CHANGING_STEPS.includes(step.type)) page = undefined;
  }
  return warnings;
}
