// The plan parts and project declarations the unsafe-feature tests share, as plain JSON a person
// writes. This module imports nothing the engine does not export today, so the recorded refusals of
// the 1.2 and 1.1 parsers (unsafe-feature-previous-versions.test.ts) were taken from these exact
// values before any 1.3 code existed.
//
// Plan language 1.3 adds six features, each off unless the trusted project.json enables it under
// `unsafeFeatures`: CSS locators, XPath locators, DOM checks, named page scripts, inline page
// scripts (which need named page scripts too) and database commands.
// See docs/specs/SPEC-36-unsafe-plan-features.md.
import { ORIGIN, TARGET_ID, TEST_SERVICE, TEST_SERVICE_SECRET_NAMES, testProjectInput, type JsonRecord } from './plan-examples.ts';

export { ORIGIN, TARGET_ID, type JsonRecord };

// The language version that holds the unsafe features, and the two before it.
export const UNSAFE_VERSION = '1.3';
export const CLOSED_VERSIONS = ['1.2', '1.1'] as const;

// The six features, as the spec names them, in the order it lists them.
export const FEATURES = ['css-locator', 'xpath-locator', 'dom-checks', 'page-script', 'inline-page-script', 'database-command'] as const;
export type FeatureName = (typeof FEATURES)[number];

// ---- Locators -----------------------------------------------------------------------------------

export const css = (selector: unknown, fields: JsonRecord = {}): JsonRecord => ({ by: 'css', selector, ...fields });
export const xpath = (expression: unknown, fields: JsonRecord = {}): JsonRecord => ({ by: 'xpath', expression, ...fields });

// ---- Steps, one or more per feature ---------------------------------------------------------------

export const OPEN_CART: JsonRecord = { type: 'navigate', url: '/cart' };

// css-locator: a record-id prefix, the first match.
export const CSS_CHECK: JsonRecord = {
  type: 'expect', locator: css('[data-test^="transaction-item-"]', { position: 'first' }), assert: { kind: 'visible' }, criterionId: 'cart.item-shown',
};
// xpath-locator: the second list item in the main region. An expression may not hold "@".
export const XPATH_CHECK: JsonRecord = {
  type: 'expect', locator: xpath('//main//li[2]'), assert: { kind: 'textContains', value: 'Total' }, criterionId: 'cart.total-shown',
};
// dom-checks, one step per check kind.
const BADGE: JsonRecord = { by: 'testId', testId: 'cart-badge' };
export const CLASS_CHECK: JsonRecord = { type: 'expect', locator: BADGE, assert: { kind: 'hasClass', value: 'is-active' }, criterionId: 'cart.badge-active' };
export const NO_CLASS_CHECK: JsonRecord = { type: 'expect', locator: BADGE, assert: { kind: 'lacksClass', value: 'is-empty' }, criterionId: 'cart.badge-not-empty' };
export const STYLE_CHECK: JsonRecord = {
  type: 'expect', locator: BADGE, assert: { kind: 'computedStyleEquals', property: 'background-color', value: 'rgb(220, 38, 38)' }, criterionId: 'cart.badge-red',
};
export const ATTRIBUTE_CHECK: JsonRecord = {
  type: 'expect', locator: { by: 'role', role: 'button', name: 'Sort by price' }, assert: { kind: 'attributeEquals', name: 'aria-sort', value: 'ascending' },
  criterionId: 'cart.sorted-by-price',
};
export const NO_ATTRIBUTE_CHECK: JsonRecord = {
  type: 'expect', locator: { by: 'role', role: 'button', name: 'Check out' }, assert: { kind: 'attributeAbsent', name: 'disabled' }, criterionId: 'cart.checkout-enabled',
};
export const REMEMBER_ATTRIBUTE: JsonRecord = {
  type: 'remember', name: 'orderId', from: { element: { by: 'testId', testId: 'order-row' }, read: 'attribute', attribute: 'data-order-id' },
};
export const DOM_CHECK_STEPS: readonly JsonRecord[] = [CLASS_CHECK, NO_CLASS_CHECK, STYLE_CHECK, ATTRIBUTE_CHECK, NO_ATTRIBUTE_CHECK, REMEMBER_ATTRIBUTE];

// page-script: a declared read script, run for a value and as a check.
export const READ_CART: JsonRecord = { type: 'evaluate', script: 'readCart', arguments: { currency: 'eur' }, remember: { cartCount: 'itemCount' } };
export const CART_COUNT_CHECK: JsonRecord = {
  type: 'expectScript', script: 'readCart', arguments: { currency: 'eur' }, field: 'itemCount', assert: { kind: 'equals', value: '3' },
  criterionId: 'cart.three-items',
};
// A declared write script that its declaration allows in proposals, and one it does not.
export const SEED_EDITOR: JsonRecord = { type: 'evaluate', script: 'seedEditor', arguments: { text: 'Hello' } };
export const CLEAR_EDITOR: JsonRecord = { type: 'evaluate', script: 'clearEditor', arguments: {} };

// inline-page-script: a read script whose text is in the plan.
export const INLINE_SOURCE = '() => ({ blocks: window.editorStore.blocks.length })';
export const INLINE_READ: JsonRecord = {
  type: 'evaluate', script: { inline: { source: INLINE_SOURCE, effect: 'read', fields: { blockCount: '/blocks' } } }, arguments: {},
  remember: { blockCount: 'blockCount' },
};

// database-command: a declared read command as a check, and declared write commands.
export const ORDER_COUNT_CHECK: JsonRecord = {
  type: 'expectDatabase', command: 'countOrders', arguments: { email: 'ada@example.com' }, field: 'count', assert: { kind: 'equals', value: '3' },
  criterionId: 'orders.three-seeded',
};
// Allowed in proposals by its declaration.
export const SEED_ORDERS: JsonRecord = { type: 'database', command: 'seedOrders', arguments: { count: 3 } };
// Not allowed in proposals by its declaration.
export const WIPE_ORDERS: JsonRecord = { type: 'database', command: 'wipeOrders', arguments: {} };

// ---- Declarations ---------------------------------------------------------------------------------

export const READ_CART_FILE = 'plans/scripts/read-cart.js';
export const SEED_EDITOR_FILE = 'plans/scripts/seed-editor.js';
export const CLEAR_EDITOR_FILE = 'plans/scripts/clear-editor.js';

// The named scripts' sources, as the files under plans/scripts/ hold them.
export const SCRIPT_SOURCES: Readonly<Record<string, string>> = {
  [READ_CART_FILE]: '(arguments_) => ({ count: window.cartStore.items.length, total: window.cartStore.total(arguments_.currency) })\n',
  [SEED_EDITOR_FILE]: '(arguments_) => { window.editorStore.reset(arguments_.text); return null; }\n',
  [CLEAR_EDITOR_FILE]: '() => { window.editorStore.reset(""); return null; }\n',
};

export const PAGE_SCRIPTS: JsonRecord = {
  readCart: {
    file: READ_CART_FILE, parameters: { currency: { kind: 'oneOf', values: ['eur', 'usd'] } }, effect: 'read',
    fields: { itemCount: '/count', total: '/total' }, allowInProposals: false,
  },
  seedEditor: { file: SEED_EDITOR_FILE, parameters: { text: { kind: 'text', maximumLength: 200 } }, effect: 'write', allowInProposals: true },
  clearEditor: { file: CLEAR_EDITOR_FILE, parameters: {}, effect: 'write', allowInProposals: false },
};

// The shop's test database: on loopback, so private, with the port commands may reach.
export const DATABASE_SERVICE: JsonRecord = { name: 'shop-database', origin: 'http://127.0.0.1', private: true, port: 5432 };
export const DATABASE_SECRET = 'SHOP_DATABASE_PASSWORD';
// A workload image pinned by digest. A test value: no such image exists.
export const COMMAND_IMAGE = `sha256:${'0123456789abcdef'.repeat(4)}`;

const command = (fields: JsonRecord): JsonRecord => ({
  service: 'shop-database', image: COMMAND_IMAGE, successExitCodes: [0],
  environment: { PGDATABASE: { literal: 'shop' }, PGPASSWORD: { secretName: DATABASE_SECRET } }, ...fields,
});

export const COUNT_ORDERS_ARGUMENTS: readonly JsonRecord[] = [
  { literal: 'node' }, { literal: 'scripts/count-orders.js' }, { literal: '--' }, { $parameter: 'email' },
];
export const DATABASE_COMMANDS: JsonRecord = {
  countOrders: command({
    argv: COUNT_ORDERS_ARGUMENTS, parameters: { email: { kind: 'email' } }, effect: 'read', output: 'json', fields: { count: '/count' },
    allowInProposals: false,
  }),
  seedOrders: command({
    argv: [{ literal: 'node' }, { literal: 'scripts/seed-orders.js' }, { $parameter: 'count' }],
    parameters: { count: { kind: 'integer', minimum: 1, maximum: 50 } }, effect: 'write', output: 'none', allowInProposals: true,
  }),
  wipeOrders: command({
    argv: [{ literal: 'node' }, { literal: 'scripts/wipe-orders.js' }], parameters: {}, effect: 'write', output: 'none', allowInProposals: false,
  }),
};

// The one CSS selector the project allows to resolve a control with no accessible name.
export const ALLOWED_UNNAMED_SELECTOR = 'button.icon-close';

// The unsafeFeatures section enabling exactly `enabled`. Inline scripts ride on the pageScripts
// entry, so inline-page-script without page-script cannot be written and is left out.
export function unsafeSection(enabled: readonly FeatureName[]): JsonRecord {
  const has = (feature: FeatureName): boolean => enabled.includes(feature);
  return {
    ...(has('css-locator') ? { cssLocators: true } : {}),
    ...(has('xpath-locator') ? { xpathLocators: true } : {}),
    ...(has('dom-checks') ? { domChecks: true } : {}),
    ...(has('page-script') ? { pageScripts: { scripts: PAGE_SCRIPTS, allowInline: has('inline-page-script') } } : {}),
    ...(has('database-command') ? { databaseCommands: { commands: DATABASE_COMMANDS } } : {}),
    ...(has('css-locator') ? { unnamedControlsAllowed: [ALLOWED_UNNAMED_SELECTOR] } : {}),
  };
}

// The shared test project (plan-examples.ts) with the shop's database and its secret declared, and
// an unsafeFeatures section enabling exactly `enabled`; none gives a project with no section at all.
export function unsafeProjectFile(enabled: readonly FeatureName[] = FEATURES, fields: JsonRecord = {}): JsonRecord {
  return testProjectInput({}, {
    services: [TEST_SERVICE, DATABASE_SERVICE],
    secretNames: [...TEST_SERVICE_SECRET_NAMES, DATABASE_SECRET],
    ...(enabled.length === 0 ? {} : { unsafeFeatures: unsafeSection(enabled) }),
    ...fields,
  });
}

// ---- Plans --------------------------------------------------------------------------------------

// The last step of every plan built here: a plan must check something.
export const CLOSING_CHECK: JsonRecord = {
  type: 'expect', locator: { by: 'testId', testId: 'status' }, assert: { kind: 'visible' }, criterionId: 'cart.status-shown',
};

// A raw plan declaring `version`: the given steps, then CLOSING_CHECK. Step indexes are the given
// steps' indexes. `fields` adds or replaces top-level fields, such as `cleanup`.
export const planIn = (version: string, steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => ({
  version,
  meta: { featureId: 'CART-1', specReference: 'specs/cart.md#totals', title: 'Cart totals' },
  targets: [TARGET_ID],
  steps: [...steps, CLOSING_CHECK],
  ...fields,
});
export const unsafePlan = (steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => planIn(UNSAFE_VERSION, steps, fields);

// One plan per feature, using that feature and no other, with the JSON path of its one use.
export type FeatureExample = { readonly feature: FeatureName; readonly steps: readonly JsonRecord[]; readonly path: string };
export const FEATURE_EXAMPLES: readonly FeatureExample[] = [
  { feature: 'css-locator', steps: [OPEN_CART, CSS_CHECK], path: '$.steps[1].locator.by' },
  { feature: 'xpath-locator', steps: [OPEN_CART, XPATH_CHECK], path: '$.steps[1].locator.by' },
  { feature: 'dom-checks', steps: [OPEN_CART, CLASS_CHECK], path: '$.steps[1].assert.kind' },
  { feature: 'page-script', steps: [OPEN_CART, READ_CART], path: '$.steps[1].type' },
  { feature: 'inline-page-script', steps: [OPEN_CART, INLINE_READ], path: '$.steps[1].script.inline' },
  { feature: 'database-command', steps: [OPEN_CART, ORDER_COUNT_CHECK], path: '$.steps[1].type' },
];

// A frame found by CSS, holding a named page-script check: page scripts may stand in a frame.
export const CSS_FRAME: JsonRecord = { type: 'frame', locator: css('iframe.editor-canvas'), steps: [CART_COUNT_CHECK] };

// A plan that uses all six features, some of them twice, with the path of every use.
export const ALL_FEATURES_PLAN = (): JsonRecord => unsafePlan(
  [OPEN_CART, CSS_CHECK, XPATH_CHECK, CLASS_CHECK, REMEMBER_ATTRIBUTE, READ_CART, INLINE_READ, ORDER_COUNT_CHECK, CSS_FRAME],
  { cleanup: [SEED_ORDERS] },
);
export const ALL_FEATURES_PATHS: readonly string[] = [
  '$.steps[1].locator.by', '$.steps[2].locator.by', '$.steps[3].assert.kind', '$.steps[4].from.read', '$.steps[5].type',
  '$.steps[6].script.inline', '$.steps[7].type', '$.steps[8].locator.by', '$.steps[8].steps[0].type', '$.cleanup[0].type',
];
