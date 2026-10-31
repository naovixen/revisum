// The static locator check of an explore draft (engine's checkDraftLocators). A step is checked
// when it follows a `Go to` whose URL is on the start origin and whose path is in the page map, and
// comes before the first click, press, select, upload or dialog step after that `Go to`. Role
// locators match map nodes of that role whose name matches as the driver's role locator matches
// (exact, spaces folded); label locators match form-control nodes by name in the same way. A
// locator with no match is locator-not-on-page, one with several is locator-ambiguous, each at
// the step's line. A cut or redacted map name counts as a possible match, so it never gives
// locator-not-on-page. Other locator kinds, steps after the page may have changed and steps on
// pages not in the map are not checked.
//
// The page map is written out here, as the crawl would give it for the contact and about pages;
// its redacted name is the engine's defaultRedactor() output, as the map holds it. Each "not
// checked" test has a counter-example: the same locator where it is checked gives a warning.
// See docs/specs/SPEC-37-explore-to-draft.md.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { defaultRedactor, planParser, readPlanText, type TrustedProject } from '@revisum/engine';
import { trustedProjectFrom } from '../../support/policy-clearance.ts';
import {
  MAXIMUM_NAME_LENGTH, SECOND_ORIGIN, START_ORIGIN, checkDraftLocators, crawlProjectFile,
  type LineWarning, type PageMap, type PageMapNode,
} from './explore-examples.ts';

let project: TrustedProject;
before(async () => { project = await trustedProjectFrom(crawlProjectFile()); });

// Exactly 200 characters; the map holds its first 80.
const LONG_NAME = 'Send this message to the Lantern Books reading room team, who answer every letter by hand within two working '
  + 'days and keep a copy in the archive of reader letters kept since the old shop first opened.';
const EMAIL_LINK = 'Write to grace.hopper@example.org';

const leaf = (role: string, name: string): PageMapNode => ({ role, name, children: [] });

const MAP: PageMap = {
  origin: START_ORIGIN,
  truncated: false,
  guaranteeLevel: 'host',
  pages: [
    {
      path: '/contact', title: 'Contact Lantern Books', depth: 1,
      tree: [{ role: 'main', name: '', children: [
        leaf('heading', 'Contact us'),
        { role: 'form', name: 'Contact form', children: [leaf('textbox', 'Display name'), leaf('button', 'Send'), leaf('button', LONG_NAME.slice(0, MAXIMUM_NAME_LENGTH))] },
        leaf('link', 'Read more'),
        leaf('link', 'Read more'),
        leaf('link', defaultRedactor().text(EMAIL_LINK)),
      ] }],
    },
    { path: '/about', title: 'About Lantern Books', depth: 2, tree: [{ role: 'main', name: '', children: [leaf('heading', 'About Lantern Books'), leaf('link', 'Home')] }] },
  ],
};

// The draft, one statement per line. Lines are found by their text below, never counted by hand.
const DRAFT_LINES = [
  'Plan: Contact the shop',
  'Feature: EXPLORE-1',
  'Spec: pages/lantern-books',
  'Version: 1.1',
  'Targets: explore-chromium',
  'Go to /contact',
  'Criterion: AC-1',
  'Expect heading "Contact us" is visible',
  'Expect button "Archive everything" is visible',
  'Expect link "Read more" is visible',
  'Expect label "Display name" is visible',
  'Expect label "Postcode" is visible',
  'Expect label "Contact us" is visible',
  `Expect button "${LONG_NAME}" is visible`,
  `Expect button "${LONG_NAME.slice(0, 40)} and some other ending" is visible`,
  `Expect link "${EMAIL_LINK}" is visible`,
  'Expect text "Nothing like this is on the page" is visible',
  'Expect button "Nowhere at all" is visible',
  'Click button "Send"',
  'Expect button "Nowhere at all" is enabled',
  'Expect link "Read more" is enabled',
  'Go to /about',
  'Expect heading "Missing from about" is visible',
  'Go to /not-in-map',
  'Expect heading "Anything at all" is visible',
  `Go to ${SECOND_ORIGIN}/contact`,
  'Expect heading "Not on the second origin" is visible',
];
const DRAFT = `${DRAFT_LINES.join('\n')}\n`;

const lineOf = (text: string): number => {
  const index = DRAFT_LINES.indexOf(text);
  assert.ok(index !== -1, `the draft has no line ${text}`);
  return index + 1;
};

async function warningsFor(draft: string, map: PageMap = MAP): Promise<readonly LineWarning[]> {
  const reading = readPlanText(draft, project.limits);
  if (!reading.ok) assert.fail(`the draft was not read: ${JSON.stringify(reading.error)}`);
  const parsed = planParser(project)(reading.value.json);
  if (!parsed.ok) assert.fail(`the draft was not parsed: ${JSON.stringify(parsed.error)}`);
  return checkDraftLocators(parsed.value, reading.value, map);
}

const at = (warnings: readonly LineWarning[], text: string): readonly string[] =>
  warnings.filter((warning) => warning.line === lineOf(text)).map((warning) => warning.code);

test('a locator missing from its page gives locator-not-on-page, and one matching two elements gives locator-ambiguous, at their lines', { criterion: 'AC-SPEC-37-08' }, async () => {
  const warnings = await warningsFor(DRAFT);
  assert.deepEqual(at(warnings, 'Expect button "Archive everything" is visible'), ['locator-not-on-page']);
  assert.deepEqual(at(warnings, 'Expect link "Read more" is visible'), ['locator-ambiguous']);
});

test('the whole draft gives exactly the expected warnings, in line order', { criterion: 'AC-SPEC-37-08' }, async () => {
  const warnings = await warningsFor(DRAFT);
  assert.deepEqual([...warnings].sort((left, right) => left.line - right.line), [
    { code: 'locator-not-on-page', line: lineOf('Expect button "Archive everything" is visible') },
    { code: 'locator-ambiguous', line: lineOf('Expect link "Read more" is visible') },
    { code: 'locator-not-on-page', line: lineOf('Expect label "Postcode" is visible') },
    { code: 'locator-not-on-page', line: lineOf('Expect label "Contact us" is visible') },
    { code: 'locator-not-on-page', line: lineOf(`Expect button "${LONG_NAME.slice(0, 40)} and some other ending" is visible`) },
    { code: 'locator-not-on-page', line: lineOf('Expect button "Nowhere at all" is visible') },
    { code: 'locator-not-on-page', line: lineOf('Expect heading "Missing from about" is visible') },
  ]);
});

test('a role locator that matches one node of its role and name gives no warning', { criterion: 'AC-SPEC-37-08' }, async () => {
  assert.deepEqual(at(await warningsFor(DRAFT), 'Expect heading "Contact us" is visible'), []);
});

test('a label locator matches a form control by name, and never a heading of that name', { criterion: 'AC-SPEC-37-08' }, async () => {
  const warnings = await warningsFor(DRAFT);
  assert.deepEqual(at(warnings, 'Expect label "Display name" is visible'), []);
  assert.deepEqual(at(warnings, 'Expect label "Postcode" is visible'), ['locator-not-on-page']);
  assert.deepEqual(at(warnings, 'Expect label "Contact us" is visible'), ['locator-not-on-page']);
});

test('a locator after a click on the same page is not checked', { criterion: 'AC-SPEC-37-08' }, async () => {
  const warnings = await warningsFor(DRAFT);
  assert.deepEqual(at(warnings, 'Expect button "Nowhere at all" is enabled'), []);
  assert.deepEqual(at(warnings, 'Expect link "Read more" is enabled'), []);
});

test('counter-example: the same missing locator before the click gives locator-not-on-page', { criterion: 'AC-SPEC-37-08' }, async () => {
  assert.deepEqual(at(await warningsFor(DRAFT), 'Expect button "Nowhere at all" is visible'), ['locator-not-on-page']);
});

for (const changing of ['Press Enter in label "Display name"', 'Select "Reader" in label "Display name"', 'Accept dialog']) {
  test(`a locator after "${changing}" on the same page is not checked`, { criterion: 'AC-SPEC-37-08' }, async () => {
    const lines = ['Plan: After a change', 'Feature: EXPLORE-1', 'Spec: pages/lantern-books', 'Version: 1.1', 'Targets: explore-chromium', 'Go to /contact', changing, 'Criterion: AC-1', 'Expect button "Nowhere at all" is visible'];
    assert.deepEqual(await warningsFor(`${lines.join('\n')}\n`), []);
  });
}

test('a new Go to a page in the map starts checking again', { criterion: 'AC-SPEC-37-08' }, async () => {
  assert.deepEqual(at(await warningsFor(DRAFT), 'Expect heading "Missing from about" is visible'), ['locator-not-on-page']);
});

test('steps on a page not in the map, or on another origin, are not checked', { criterion: 'AC-SPEC-37-08' }, async () => {
  const warnings = await warningsFor(DRAFT);
  assert.deepEqual(at(warnings, 'Expect heading "Anything at all" is visible'), []);
  assert.deepEqual(at(warnings, 'Expect heading "Not on the second origin" is visible'), []);
});

test('counter-example: with /not-in-map in the map, the same step is checked and gives locator-not-on-page', { criterion: 'AC-SPEC-37-08' }, async () => {
  const withPage: PageMap = { ...MAP, pages: [...MAP.pages, { path: '/not-in-map', title: 'Now mapped', depth: 1, tree: [leaf('heading', 'Something else')] }] };
  assert.deepEqual(at(await warningsFor(DRAFT, withPage), 'Expect heading "Anything at all" is visible'), ['locator-not-on-page']);
});

test('a text locator is not checked', { criterion: 'AC-SPEC-37-08' }, async () => {
  assert.deepEqual(at(await warningsFor(DRAFT), 'Expect text "Nothing like this is on the page" is visible'), []);
});

test('a name the map holds cut to 80 characters counts as a possible match, and one that starts otherwise does not', { criterion: 'AC-SPEC-37-08' }, async () => {
  const warnings = await warningsFor(DRAFT);
  assert.deepEqual(at(warnings, `Expect button "${LONG_NAME}" is visible`), []);
  assert.deepEqual(at(warnings, `Expect button "${LONG_NAME.slice(0, 40)} and some other ending" is visible`), ['locator-not-on-page']);
});

test('a name the map holds redacted counts as a possible match, so it gives no locator-not-on-page', { criterion: 'AC-SPEC-37-08' }, async () => {
  assert.equal(at(await warningsFor(DRAFT), `Expect link "${EMAIL_LINK}" is visible`).includes('locator-not-on-page'), false);
});

test('counter-example: the same link against a map that holds another, unredacted name gives locator-not-on-page', { criterion: 'AC-SPEC-37-08' }, async () => {
  const contact = MAP.pages[0];
  assert.ok(contact !== undefined);
  const otherName: PageMap = { ...MAP, pages: [{ ...contact, tree: [leaf('link', 'Write to the reading room')] }] };
  assert.deepEqual(at(await warningsFor(DRAFT, otherName), `Expect link "${EMAIL_LINK}" is visible`), ['locator-not-on-page']);
});

test('the check is pure: the same draft and map give the same warnings each time', { criterion: 'AC-SPEC-37-08' }, async () => {
  assert.deepEqual(await warningsFor(DRAFT), await warningsFor(DRAFT));
});
