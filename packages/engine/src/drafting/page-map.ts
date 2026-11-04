// The page map: what a crawl of the running app saw, and the only page content a planner sees.
// Per page it keeps the URL path (no query or fragment), the title, the crawl depth and an outline
// of the accessibility tree with role and accessible name only, for landmarks, headings, links,
// buttons, form controls, lists, tables, dialogs, tabs and menus. Text content (static text,
// paragraphs) is dropped, and form-control values are never in the tree, so none can be read.
// Every name and title is redacted first (the project's secrets, then personal-data shapes) and
// then cut to 80 characters, so a cut can never leave part of a secret behind.
//
// A page map that comes back from the isolated runner is outside data: decodePageMap checks every
// field and bound before the command uses it.
import {
  failure, isPlainObject, success,
  type A11yNode, type Origin, type PageMap, type PageMapEntry, type PageMapNode, type Redactor, type Result,
} from '@revisum/contracts';
import { canonicalJson, sha256 } from '../hashing.ts';

// The roles a page map keeps. A node of any other role is dropped and its kept descendants take
// its place, in order.
const PAGE_MAP_ROLES: readonly string[] = [
  'banner', 'main', 'navigation', 'contentinfo', 'complementary', 'region', 'search', 'form', 'heading', 'link', 'button', 'textbox',
  'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'slider', 'spinbutton', 'switch', 'list', 'listitem', 'table',
  'row', 'cell', 'columnheader', 'rowheader', 'dialog', 'alertdialog', 'tab', 'tablist', 'tabpanel', 'menu', 'menubar', 'menuitem',
  'menuitemcheckbox', 'menuitemradio',
];
const KEPT_ROLES = new Set(PAGE_MAP_ROLES);

// Names and titles are cut to exactly their first 80 characters, with no ellipsis.
export const MAXIMUM_PAGE_MAP_NAME_LENGTH = 80;
// The most pages and the deepest link depth any crawl may reach.
export const MAXIMUM_EXPLORE_PAGES = 100;
export const MAXIMUM_EXPLORE_DEPTH = 5;
// A decoded map may hold no more nodes than this, nested no deeper, so a hostile container output
// cannot exhaust memory or the stack.
const MAXIMUM_DECODED_NODES = 50_000;
const MAXIMUM_TREE_NESTING = 256;
const MAXIMUM_PATH_LENGTH = 2048;

const bounded = (text: string, redact: Redactor): string => redact.text(text).slice(0, MAXIMUM_PAGE_MAP_NAME_LENGTH);

function outline(node: A11yNode, redact: Redactor): PageMapNode[] {
  const children = node.children.flatMap((child) => outline(child, redact));
  return KEPT_ROLES.has(node.role) ? [{ role: node.role, name: bounded(node.name, redact), children }] : children;
}

// The URL's path alone; a URL the browser could not have shown is the root.
function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

// One page's entry, from its accessibility tree, URL, title and crawl depth. Pure.
export function pageMapEntry(tree: A11yNode, url: string, title: string, depth: number, redact: Redactor): PageMapEntry {
  return { path: redact.text(pathOf(url)), title: bounded(title, redact), depth, tree: outline(tree, redact) };
}

// The page map again with every name, title and path passed through the redactor once more, for a
// map that was redacted elsewhere, such as in the run container.
export function redactPageMap(map: PageMap, redact: Redactor): PageMap {
  const again = (nodes: readonly PageMapNode[]): PageMapNode[] =>
    nodes.map((node) => ({ role: node.role, name: bounded(node.name, redact), children: again(node.children) }));
  return {
    ...map,
    pages: map.pages.map((page) => ({ path: redact.text(page.path), title: bounded(page.title, redact), depth: page.depth, tree: again(page.tree) })),
  };
}

// The page map file's text: canonical JSON (sorted keys, no spaces) and a final newline, so the
// same site always gives the same bytes.
export const pageMapText = (map: PageMap): string => `${canonicalJson(map)}\n`;
// The draft's provenance reference for a page map file: "sha256:" and the hex sha256 of its bytes.
export const pageMapReference = (text: string): string => `sha256:${sha256(new TextEncoder().encode(text))}`;

// ---- Decoding a page map from outside --------------------------------------------------------------

// Why a page map from outside was refused: the JSON path of the first field that is wrong.
type PageMapDecodeError = { readonly code: 'page-map-invalid'; readonly path: string };

const hasExactly = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean => {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};
const isBoundedText = (value: unknown): value is string => typeof value === 'string' && value.length <= MAXIMUM_PAGE_MAP_NAME_LENGTH;

class Refusal extends Error {
  readonly path: string;

  constructor(path: string) {
    super('page map invalid');
    this.path = path;
  }
}

// Decodes a page map that `origin` was crawled for, such as the JSON the crawl in the run container
// printed. Every field is checked: the origin is the one asked for, the guarantee level one of the
// two, at most 100 pages no deeper than 5, each with a path, a title and names of at most 80
// characters and only kept roles, and no other field anywhere.
export function decodePageMap(input: unknown, origin: Origin): Result<PageMap, PageMapDecodeError> {
  let nodes = 0;
  const decodeNodes = (value: unknown, path: string, nesting: number): PageMapNode[] => {
    if (!Array.isArray(value) || nesting > MAXIMUM_TREE_NESTING) throw new Refusal(path);
    return value.map((node: unknown, index: number): PageMapNode => {
      const at = `${path}[${index}]`;
      nodes += 1;
      if (nodes > MAXIMUM_DECODED_NODES || !isPlainObject(node) || !hasExactly(node, ['role', 'name', 'children'])) throw new Refusal(at);
      const { role, name } = node;
      if (typeof role !== 'string' || !KEPT_ROLES.has(role) || !isBoundedText(name)) throw new Refusal(at);
      return { role, name, children: decodeNodes(node['children'], `${at}.children`, nesting + 1) };
    });
  };
  const decodePage = (value: unknown, path: string): PageMapEntry => {
    if (!isPlainObject(value) || !hasExactly(value, ['path', 'title', 'depth', 'tree'])) throw new Refusal(path);
    const { path: pagePath, title, depth } = value;
    if (typeof pagePath !== 'string' || !pagePath.startsWith('/') || pagePath.length > MAXIMUM_PATH_LENGTH) throw new Refusal(`${path}.path`);
    if (!isBoundedText(title)) throw new Refusal(`${path}.title`);
    if (typeof depth !== 'number' || !Number.isInteger(depth) || depth < 0 || depth > MAXIMUM_EXPLORE_DEPTH) throw new Refusal(`${path}.depth`);
    return { path: pagePath, title, depth, tree: decodeNodes(value['tree'], `${path}.tree`, 0) };
  };
  try {
    if (!isPlainObject(input) || !hasExactly(input, ['origin', 'pages', 'truncated', 'guaranteeLevel'])) throw new Refusal('$');
    if (input['origin'] !== origin) throw new Refusal('$.origin');
    const { truncated, guaranteeLevel } = input;
    if (typeof truncated !== 'boolean') throw new Refusal('$.truncated');
    if (guaranteeLevel !== 'isolated' && guaranteeLevel !== 'host') throw new Refusal('$.guaranteeLevel');
    const pages = input['pages'];
    if (!Array.isArray(pages) || pages.length > MAXIMUM_EXPLORE_PAGES) throw new Refusal('$.pages');
    return success({ origin, pages: pages.map((page: unknown, index: number) => decodePage(page, `$.pages[${index}]`)), truncated, guaranteeLevel });
  } catch (error) {
    if (error instanceof Refusal) return failure({ code: 'page-map-invalid', path: error.path });
    throw error;
  }
}
