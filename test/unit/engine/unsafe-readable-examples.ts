// Shared setup for the readable form of plan 1.3's unsafe constructs: every line holding one starts
// with the mark "Unsafe:", and the text reader still only turns lines into plain JSON for the one
// plan parser, which decides what is allowed.
//
//   - parseAll is the plan parser of the shared unsafe project (unsafe-feature-steps.ts) with all
//     six features enabled, and unsafeLimits its plan limits;
//   - the golden texts are golden/readable-unsafe-plans/<feature>.plan: the six 1.3 golden plans
//     (golden/unsafe-plans/) exactly as the spec prints them, under its five headers;
//   - UNSAFE_COVERAGE_PLANS are 1.3 plans that, with the golden plans, use every unsafe construct
//     and every readable form the spec gives it: nested locators to the deepest chain allowed,
//     every DOM check, named and inline scripts with and without arguments, returned fields and
//     remembered fields, multi-line sources holding tabs, carriage returns, quotes and backslashes,
//     and database commands in steps and in Clean up:;
//   - generatedUnsafePlans() is the property test's generator: the coverage plans with selectors,
//     expressions, class names and script sources replaced by seeded text that is hard to write.
//
// Every plan is built as JSON and parsed before it is used, so a plan the parser refuses is a
// broken test and throws. Readable text is written by hand only where the spec prints it.
// See docs/specs/SPEC-28-plan-authoring.md ("Readable syntax for plan 1.3").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readPlanText, type DraftError, type Plan, type StepType, type TextReading } from '@revisum/engine';
import { GOLDEN } from '../../support/repository.ts';
import { EVERY_STEP_TYPE, seededNumbers } from './readable-plan-examples.ts';
import { parsedProject, parserEnabling, type ParsePlan } from './unsafe-feature-examples.ts';
import {
  CART_COUNT_CHECK, CLASS_CHECK, CLOSING_CHECK, FEATURES, INLINE_SOURCE, OPEN_CART, ORDER_COUNT_CHECK, READ_CART, SEED_ORDERS, css,
  unsafePlan, unsafeProjectFile, xpath, type FeatureName, type JsonRecord,
} from './unsafe-feature-steps.ts';

export { FEATURES, type FeatureName, type JsonRecord, type ParsePlan };

export const parseAll: ParsePlan = parserEnabling(FEATURES);
export const unsafeLimits = () => parsedProject(unsafeProjectFile()).limits;

export const UNSAFE_MARK = 'Unsafe:';

// ---- Golden plans and their texts ---------------------------------------------------------------

const GOLDEN_JSON_FOLDER = join(GOLDEN, 'unsafe-plans');
const GOLDEN_TEXT_FOLDER = join(GOLDEN, 'readable-unsafe-plans');

export const unsafeGoldenJsonFile = (feature: FeatureName): string => readFileSync(join(GOLDEN_JSON_FOLDER, `${feature}.json`), 'utf8');
export const unsafeGoldenPlan = (feature: FeatureName): JsonRecord => JSON.parse(unsafeGoldenJsonFile(feature));
export const unsafeGoldenText = (feature: FeatureName): string => readFileSync(join(GOLDEN_TEXT_FOLDER, `${feature}.plan`), 'utf8');
export const GOLDEN_TEXT_FOLDER_PATH = GOLDEN_TEXT_FOLDER;

// The plan the parser makes from `input`; a refusal is a broken test.
export function parsedWith(parsePlan: ParsePlan, input: unknown, label: string): Plan {
  const parsed = parsePlan(input);
  if (!parsed.ok) throw new Error(`${label} was refused: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// The reading of `text`; a refusal is a broken test.
export function readingOf(text: string, label: string): TextReading {
  const read = readPlanText(text, unsafeLimits());
  if (!read.ok) throw new Error(`${label}: the text was refused: ${JSON.stringify(read.error)}\n${text}`);
  return read.value;
}

// The plan that text reads and parses to, with every feature enabled.
export const planFromText = (text: string, label: string): Plan => parsedWith(parseAll, readingOf(text, label).json, `${label} read from text`);

// The text errors of a refused reading; an accepted one is a broken test.
export function textErrorsOf(text: string): readonly DraftError[] {
  const read = readPlanText(text, unsafeLimits());
  if (read.ok) throw new Error(`the text was accepted:\n${text}`);
  return read.error;
}

// ---- Plans that cover every unsafe construct ------------------------------------------------------

const role = (name: unknown, roleName: string): JsonRecord => ({ by: 'role', role: roleName, name });
const testId = (id: string): JsonRecord => ({ by: 'testId', testId: id });
const expect = (locator: JsonRecord, assertion: JsonRecord, criterionId: string): JsonRecord => ({ type: 'expect', locator, assert: assertion, criterionId });
const reference = (valueName: string): JsonRecord => ({ valueName });
const withMeta = (plan: JsonRecord, featureId: string, title: string): JsonRecord =>
  ({ ...plan, meta: { featureId, specReference: `specs/${featureId.toLowerCase()}.md#unsafe`, title } });

// CSS and XPath locators in every place and form: positions, containing text, inside chains of one,
// two and three links mixing both kinds, a selector holding quotes, a backslash, "#", ":" and ",",
// a frame found by CSS holding closed and unsafe steps, a closed frame holding an unsafe step, and a
// second tab.
function structuralLocators(): JsonRecord {
  return withMeta(unsafePlan([
    OPEN_CART,
    { type: 'click', locator: css('button.icon-close') },
    expect(xpath('//main//li[2]', { position: 'last' }), { kind: 'visible' }, 'locators.last-item'),
    expect(css('li.product', { position: 1 }), { kind: 'visible' }, 'locators.first-product'),
    { type: 'click', locator: css('button', { hasText: 'Add', inside: css('li.product', { position: 2 }) }) },
    { type: 'hover', locator: xpath('//nav//a', { position: 'first', hasText: 'Help' }) },
    {
      type: 'click',
      locator: css('span.price', { inside: xpath('//section[2]', { hasText: 'Basket', inside: css('main', { inside: xpath('/html/body') }) }) }),
    },
    { type: 'fill', locator: css('input.quantity', { inside: css('form#basket') }), value: '2' },
    // The locator's own containing text against the check's text.
    expect(css('p.note', { hasText: 'Add' }), { kind: 'textContains', value: 'Add' }, 'locators.text-in-locator-and-check'),
    expect(css('a[title="say \\"hi\\" \\\\ now"]#main:hover, li'), { kind: 'visible' }, 'locators.awkward-selector'),
    expect(xpath('//td[contains(., "a \\"b\\"")]'), { kind: 'countEquals', value: 3 }, 'locators.awkward-expression'),
    {
      type: 'frame', locator: css('iframe.editor-canvas'), steps: [
        { type: 'click', locator: role('Save', 'button') },
        expect({ by: 'text', text: 'Saved' }, { kind: 'visible' }, 'locators.saved-in-frame'),
        expect(xpath('//p[1]'), { kind: 'hidden' }, 'locators.hidden-in-frame'),
      ],
    },
    { type: 'frame', locator: role('Editor', 'region'), steps: [expect(css('div.toolbar'), { kind: 'visible' }, 'locators.toolbar-in-frame')] },
    { type: 'newTab', url: '/cart/print', steps: [expect(xpath('//h1'), { kind: 'visible' }, 'locators.print-heading')] },
  ]), 'LOCATORS-13', 'Every structural locator');
}

// Every DOM check, on closed and structural locators, an expected attribute value that is the word
// "absent", a value reference, and remembering an attribute through a CSS locator.
function domChecks(): JsonRecord {
  return withMeta(unsafePlan([
    OPEN_CART,
    CLASS_CHECK,
    expect(css('li.product', { position: 2 }), { kind: 'lacksClass', value: 'is-"sold",out{x}' }, 'dom.not-sold-out'),
    expect(testId('cart-badge'), { kind: 'computedStyleEquals', property: '-webkit-line-clamp', value: '2' }, 'dom.clamped'),
    expect(xpath('//button[1]'), { kind: 'computedStyleEquals', property: 'color', value: 'rgb(0, 0, 0)' }, 'dom.black'),
    expect(role('Sort by price', 'button'), { kind: 'attributeEquals', name: 'aria-sort', value: 'absent' }, 'dom.word-absent'),
    expect(role('Check out', 'button'), { kind: 'attributeAbsent', name: 'disabled' }, 'dom.no-attribute'),
    { type: 'remember', name: 'orderId', from: { element: css('tr.order', { position: 'first' }), read: 'attribute', attribute: 'data-order-id' } },
    expect(testId('order-link'), { kind: 'attributeEquals', name: 'data-order-id', value: reference('orderId') }, 'dom.order-kept'),
  ]), 'DOM-13', 'Every DOM check');
}

// Sources that are hard to write down: several lines, a tab, CRLF line ends, a final line break,
// empty lines, quotes and backslashes, a line starting with "#", a line ending with ":", the mark's
// own word, leading and trailing spaces, and letters outside ASCII.
export const AWKWARD_SOURCES: readonly string[] = [
  '() => {\n\tconst rows = document.querySelectorAll("tr.order");\n  return { count: rows.length };\n}',
  '() => {\r\n  return { count: 1 };\r\n}\r\n',
  '\n\n() => ({ blocks: 2 })\n\n',
  '  () => ({ text: "a \\"quoted\\" \\\\ path" })  ',
  '# not a comment\n() => ({ label: "Unsafe: kept" }) // ends with a colon:',
  '() => ({ name: "日本語 émoji 🙂" })\t',
];

const inlineScript = (source: string, effect: 'read' | 'write', fields?: JsonRecord): JsonRecord =>
  ({ inline: { source, effect, ...(fields === undefined ? {} : { fields }) } });

// Named scripts with and without arguments and remembered fields, every field check, inline read
// and write scripts with and without returned fields, and awkward sources.
function pageScripts(): JsonRecord {
  const scriptCheck = (assertion: JsonRecord, criterionId: string): JsonRecord => ({ ...CART_COUNT_CHECK, assert: assertion, criterionId });
  return withMeta(unsafePlan([
    OPEN_CART,
    READ_CART,
    { type: 'evaluate', script: 'readCart', arguments: { currency: 'usd' } },
    { type: 'evaluate', script: 'readCart', arguments: { currency: 'eur' }, remember: {} },
    { type: 'evaluate', script: 'readCart', arguments: { currency: 'eur' }, remember: { cartTotal: 'total', itemsAgain: 'itemCount' } },
    { type: 'evaluate', script: 'seedEditor', arguments: { text: reference('cartCount') } },
    { type: 'evaluate', script: 'clearEditor', arguments: {} },
    scriptCheck({ kind: 'present' }, 'scripts.count-present'),
    { ...scriptCheck({ kind: 'absent' }, 'scripts.total-absent'), field: 'total' },
    scriptCheck({ kind: 'equals', value: '3' }, 'scripts.count-three'),
    scriptCheck({ kind: 'contains', value: reference('cartCount') }, 'scripts.count-kept'),
    scriptCheck({ kind: 'numberEquals', value: 3 }, 'scripts.count-number'),
    { ...scriptCheck({ kind: 'numberEquals', value: -0.5 }, 'scripts.total-negative-fraction'), field: 'total' },
    { type: 'evaluate', script: inlineScript(INLINE_SOURCE, 'read', { blockCount: '/blocks' }), arguments: {}, remember: { blockCount: 'blockCount' } },
    { type: 'evaluate', script: inlineScript(AWKWARD_SOURCES[0] ?? '', 'read', { count: '/count', whole: '' }), arguments: {} },
    { type: 'evaluate', script: inlineScript(AWKWARD_SOURCES[1] ?? '', 'read', {}), arguments: {}, remember: {} },
    { type: 'evaluate', script: inlineScript(AWKWARD_SOURCES[2] ?? '', 'write'), arguments: {} },
    { type: 'evaluate', script: inlineScript(AWKWARD_SOURCES[3] ?? '', 'read'), arguments: {} },
    { type: 'evaluate', script: inlineScript(AWKWARD_SOURCES[4] ?? '', 'write'), arguments: {} },
    {
      type: 'expectScript', script: inlineScript(AWKWARD_SOURCES[0] ?? '', 'read', { count: '/count' }), arguments: {}, field: 'count',
      assert: { kind: 'numberEquals', value: 2 }, criterionId: 'scripts.rows-counted',
    },
    {
      type: 'expectScript', script: inlineScript(AWKWARD_SOURCES[5] ?? '', 'read', { name: '/name' }), arguments: {}, field: 'name',
      assert: { kind: 'contains', value: '日本語' }, criterionId: 'scripts.name-shown',
    },
    { type: 'frame', locator: role('Editor', 'region'), steps: [CART_COUNT_CHECK] },
  ]), 'SCRIPTS-13', 'Every page script form');
}

// Database commands with literal, numeric and run-value arguments, remembered fields, every field
// check, and Clean up: holding a command and a call.
function databaseCommands(): JsonRecord {
  const countCheck = (assertion: JsonRecord, criterionId: string): JsonRecord => ({ ...ORDER_COUNT_CHECK, assert: assertion, criterionId });
  return withMeta(unsafePlan([
    OPEN_CART,
    SEED_ORDERS,
    { type: 'database', command: 'countOrders', arguments: { email: reference('contact') }, remember: { orderCount: 'count' } },
    { type: 'database', command: 'countOrders', arguments: { email: 'ada@example.com' }, remember: {} },
    countCheck({ kind: 'present' }, 'orders.count-present'),
    countCheck({ kind: 'absent' }, 'orders.count-absent'),
    countCheck({ kind: 'equals', value: '3' }, 'orders.three'),
    countCheck({ kind: 'contains', value: reference('orderCount') }, 'orders.count-kept'),
    countCheck({ kind: 'numberEquals', value: 3 }, 'orders.three-number'),
    { type: 'database', command: 'wipeOrders', arguments: {} },
  ], {
    values: { contact: { kind: 'uniqueEmail', localPrefix: 'ada', domain: 'example.com' } },
    cleanup: [SEED_ORDERS, { type: 'call', call: 'resetShop', arguments: {} }, { type: 'database', command: 'wipeOrders', arguments: {} }],
  }), 'ORDERS-13', 'Every database command form');
}

export const UNSAFE_COVERAGE_PLANS: Readonly<Record<string, () => JsonRecord>> = {
  'structural-locators': structuralLocators,
  'dom-checks': domChecks,
  'page-scripts': pageScripts,
  'database-commands': databaseCommands,
};

// Every unsafe example: the six golden plans and the coverage plans, by name.
export function everyUnsafeExample(): readonly { readonly name: string; readonly plan: JsonRecord }[] {
  return [
    ...FEATURES.map((feature) => ({ name: `golden ${feature}`, plan: unsafeGoldenPlan(feature) })),
    ...Object.entries(UNSAFE_COVERAGE_PLANS).map(([name, build]) => ({ name: `coverage ${name}`, plan: build() })),
  ];
}

// ---- What a set of plans covers -------------------------------------------------------------------

// The step types plan 1.3 adds. With the closed list of readable-plan-examples.ts they are every
// step type, so a new step type fails to compile here until the readable examples cover it.
export const UNSAFE_STEP_TYPES = ['evaluate', 'expectScript', 'database', 'expectDatabase'] as const satisfies readonly StepType[];
type StepTypeLeftOut = Exclude<StepType, (typeof EVERY_STEP_TYPE)[number] | (typeof UNSAFE_STEP_TYPES)[number]>;
export const NO_STEP_TYPE_LEFT_OUT: [StepTypeLeftOut] extends [never] ? true : false = true;

const isRecord = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);

// The unsafe constructs and readable forms a plan uses, as words such as "locator css inside 3" or
// "inline source with tab", to compare with UNSAFE_LANGUAGE_FEATURES.
export function unsafeFeaturesUsed(plan: JsonRecord): Set<string> {
  const features = new Set<string>();
  const visitLocator = (locator: JsonRecord, depth: number): void => {
    const kind = String(locator['by']);
    if (kind !== 'css' && kind !== 'xpath') return;
    features.add(`locator ${kind}`);
    if (Object.hasOwn(locator, 'position')) features.add(`locator ${kind} position`);
    if (Object.hasOwn(locator, 'hasText')) features.add(`locator ${kind} containing text`);
    const inner = locator['inside'];
    if (isRecord(inner)) {
      features.add(`inside depth ${depth + 1}`);
      visitLocator(inner, depth + 1);
    }
  };
  const visitSource = (source: string): void => {
    if (source.includes('\n')) features.add('inline source with several lines');
    if (source.includes('\t')) features.add('inline source with tab');
    if (source.includes('\r')) features.add('inline source with carriage return');
    if (source.endsWith('\n')) features.add('inline source ending with a line break');
    if (source.includes('\n\n')) features.add('inline source with an empty line');
    if (source.includes('"') && source.includes('\\')) features.add('inline source with quotes and backslashes');
    if (/(^|\n)#/.test(source)) features.add('inline source with a line starting with #');
    if (/:($|\r?\n)/.test(source)) features.add('inline source with a line ending with a colon');
    if (/(^|\n) /.test(source) && / (\r?\n|$)/.test(source)) features.add('inline source with leading and trailing spaces');
  };
  const visitScriptStep = (step: JsonRecord, type: string): void => {
    const script = step['script'];
    if (typeof script === 'string') features.add(`${type} named`);
    if (isRecord(script) && isRecord(script['inline'])) {
      const inline = script['inline'];
      features.add(`${type} inline ${String(inline['effect'])}`);
      const fields = inline['fields'];
      features.add(fields === undefined ? 'inline without returning' : isRecord(fields) && Object.keys(fields).length === 0 ? 'inline returning nothing' : 'inline returning');
      if (isRecord(fields) && Object.values(fields).includes('')) features.add('inline returning the whole result');
      if (typeof inline['source'] === 'string') visitSource(inline['source']);
    }
  };
  const visitStep = (step: JsonRecord, where: string): void => {
    const type = String(step['type']);
    const locator = step['locator'];
    if (isRecord(locator)) {
      visitLocator(locator, 0);
      if (type === 'frame' && (locator['by'] === 'css' || locator['by'] === 'xpath')) features.add('frame structural');
    }
    const assertion = step['assert'];
    if (isRecord(assertion)) {
      const kind = String(assertion['kind']);
      if (['hasClass', 'lacksClass', 'computedStyleEquals', 'attributeEquals', 'attributeAbsent'].includes(kind)) features.add(`dom ${kind}`);
      if (type === 'expectScript' || type === 'expectDatabase') features.add(`${type} ${kind}`);
    }
    if (type === 'remember' && isRecord(step['from']) && step['from']['read'] === 'attribute') features.add('remember attribute');
    if (type === 'evaluate' || type === 'expectScript') visitScriptStep(step, type);
    if (type === 'evaluate' || type === 'database') {
      const remember = step['remember'];
      features.add(remember === undefined ? `${type} without remembering` : isRecord(remember) && Object.keys(remember).length === 0
        ? `${type} remembering nothing` : `${type} remembering`);
    }
    if (UNSAFE_STEP_TYPES.some((unsafe) => unsafe === type)) {
      features.add(`step ${type} in ${where}`);
      const args = step['arguments'];
      if (isRecord(args)) {
        if (Object.keys(args).length === 0) features.add(`${type} with no arguments`);
        for (const value of Object.values(args)) features.add(`argument ${isRecord(value) ? 'reference' : typeof value}`);
      }
    }
    const nested = step['steps'];
    if (Array.isArray(nested)) for (const inner of nested) if (isRecord(inner)) visitStep(inner, type === 'frame' ? 'frame' : 'tab');
  };
  for (const step of (plan['steps'] ?? []) as unknown[]) if (isRecord(step)) visitStep(step, 'steps');
  for (const step of (plan['cleanup'] ?? []) as unknown[]) if (isRecord(step)) visitStep(step, 'cleanup');
  return features;
}

// Every unsafe construct and readable form the spec's plan 1.3 addition gives, in the words above.
export const UNSAFE_LANGUAGE_FEATURES: readonly string[] = [
  ...['css', 'xpath'].flatMap((kind) => [`locator ${kind}`, `locator ${kind} position`, `locator ${kind} containing text`]),
  'inside depth 1', 'inside depth 2', 'inside depth 3', 'frame structural',
  'dom hasClass', 'dom lacksClass', 'dom computedStyleEquals', 'dom attributeEquals', 'dom attributeAbsent', 'remember attribute',
  'evaluate named', 'expectScript named', 'evaluate inline read', 'evaluate inline write', 'expectScript inline read',
  'inline without returning', 'inline returning nothing', 'inline returning', 'inline returning the whole result',
  'inline source with several lines', 'inline source with tab', 'inline source with carriage return',
  'inline source ending with a line break', 'inline source with an empty line', 'inline source with quotes and backslashes',
  'inline source with a line starting with #', 'inline source with a line ending with a colon', 'inline source with leading and trailing spaces',
  'evaluate without remembering', 'evaluate remembering nothing', 'evaluate remembering',
  'database without remembering', 'database remembering nothing', 'database remembering',
  ...['expectScript', 'expectDatabase'].flatMap((type) => ['present', 'absent', 'equals', 'contains', 'numberEquals'].map((kind) => `${type} ${kind}`)),
  'step evaluate in steps', 'step expectScript in steps', 'step expectScript in frame', 'step database in steps', 'step expectDatabase in steps',
  'step database in cleanup',
  'evaluate with no arguments', 'database with no arguments', 'argument string', 'argument number', 'argument reference',
];

// ---- The property test's generator -----------------------------------------------------------------

// Pieces of selector text that are hard to write down: quotes, backslashes, the comment sign,
// grammar words, the mark itself and letters outside ASCII. None is a character a selector may not
// hold ({, }, ; and @) or a control character.
const SELECTOR_PIECES = [
  '"', '\\', '\\"', '#', ' inside ', ' containing text ', 'css ', 'xpath ', 'Unsafe: ', ':', ', ', '  ', ' ', '日本語', 'é', '[1]',
  'li', 'div.card', '>', '*', '//', '(', ')', '=', "'", 'is visible', '2nd ',
];
// Pieces of script source: every control character a source may hold (tab, LF and CR, alone and as
// CRLF), quotes, backslashes, the comment sign, a colon, spaces, the mark and letters outside ASCII.
const SOURCE_PIECES = [
  '\t', '\n', '\r', '\r\n', '"', '\\', '\\"', '""', '#', ':', ' ', '  ', 'Unsafe: ', '日本語', '🙂', 'return 1;', '() => ({})', '{', '}',
  '`', "'", '/* : */', '\\t', '\\r', '\\n',
];

function pick(next: () => number, pieces: readonly string[], minimum: number, maximum: number): string {
  const count = minimum + Math.floor(next() * (maximum - minimum + 1));
  let result = '';
  for (let index = 0; index < count; index += 1) result += pieces[Math.floor(next() * pieces.length)] ?? 'x';
  return result;
}

const awkwardSelector = (next: () => number): string => `a${pick(next, SELECTOR_PIECES, 1, 6)}b`;
const awkwardSource = (next: () => number): string => pick(next, SOURCE_PIECES, 1, 12);

function replaceUnsafeText(value: unknown, next: () => number, key: string): unknown {
  if (typeof value === 'string') {
    if (key === 'selector' || key === 'expression') return awkwardSelector(next);
    if (key === 'source') return awkwardSource(next);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => replaceUnsafeText(item, next, ''));
  if (isRecord(value)) {
    // A class token holds no white space; keep the rest of a DOM check as it is.
    if (value['kind'] === 'hasClass' || value['kind'] === 'lacksClass') return { ...value, value: `c${pick(next, ['"', '\\', '{x}', ',', '#', '日'], 1, 4)}` };
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, replaceUnsafeText(child, next, childKey)]));
  }
  return value;
}

// `count` plans with awkward unsafe text, from every unsafe example in turn, each with its seed.
// Only plans the parser accepts are kept; the caller checks there are enough.
export function generatedUnsafePlans(firstSeed: number, count: number): readonly { readonly seed: number; readonly name: string; readonly plan: JsonRecord }[] {
  const examples = everyUnsafeExample();
  const generated: { seed: number; name: string; plan: JsonRecord }[] = [];
  for (let seed = firstSeed; seed < firstSeed + count; seed += 1) {
    const example = examples[seed % examples.length];
    if (example === undefined) continue;
    const plan = replaceUnsafeText(example.plan, seededNumbers(seed), '') as JsonRecord;
    if (parseAll(plan).ok) generated.push({ seed, name: example.name, plan });
  }
  return generated;
}

// ---- Small plans for the error tests ----------------------------------------------------------------

// A 1.3 plan holding `steps`, then the closing check, under the shared headers.
export const smallUnsafePlan = (steps: readonly unknown[], fields: JsonRecord = {}): JsonRecord => unsafePlan(steps, fields);
export { CLOSING_CHECK, OPEN_CART };
