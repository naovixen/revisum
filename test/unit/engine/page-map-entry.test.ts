// One page's entry in the page map, built by the engine's pure pageMapEntry from the page's
// accessibility tree. It keeps the URL's path (no query or fragment), the title, the crawl depth and
// an outline of the tree: role and accessible name only, for the kept roles. A node of any other
// role is dropped and its kept descendants take its place, in order, so text content (static text,
// paragraphs) never reaches the map, and form-control values, which the tree never carries, cannot
// either. Each name is redacted first, by the redactor given (the project's secrets, then email,
// phone and card shapes), and then cut to 80 characters.
//
// The redactor these tests pass is the engine's defaultRedactor() with the declared secret's value
// replaced first, as withSecretRedaction does. Each leak test has a counter-example: the same page
// through a redactor that redacts nothing keeps the value, so the scan can see it.
// See docs/specs/SPEC-37-explore-to-draft.md.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SECRET_PLACEHOLDER, defaultRedactor, type A11yNode, type Redactor } from '@revisum/engine';
import {
  DROPPED_ROLES, KEPT_ROLES, MAXIMUM_NAME_LENGTH, allNodes, pageMapEntry, type PageMapEntry, type PageMapNode,
} from './explore-examples.ts';
import { letterNonce } from './secret-examples.ts';

// The seeded canaries, letters only so no personal-data pattern changes them.
const SECRET_VALUE = `Officekey${letterNonce(24)}`;
const PARAGRAPH_TEXT = `Paragraphcanary${letterNonce(16)}`;
const FIELD_VALUE = `Fieldvaluecanary${letterNonce(16)}`;
const EMAIL = 'grace.hopper@example.org';
// Exactly 200 characters.
const LONG_NAME = 'Send this message to the Lantern Books reading room team, who answer every letter by hand within two working '
  + 'days and keep a copy in the archive of reader letters kept since the old shop first opened.';

const PAGE_URL = 'http://127.0.0.1:4310/contact.html?from=newsletter&reader=ada#form';

// The project's redaction: the declared secret first, then the default personal-data rules.
const projectRedactor = (): Redactor => {
  const personalData = defaultRedactor();
  return { selectors: personalData.selectors, text: (value) => personalData.text(value.replaceAll(SECRET_VALUE, SECRET_PLACEHOLDER)) };
};
// The counter-example's redactor: it redacts nothing.
const noRedaction: Redactor = { selectors: [], text: (value) => value };

const node = (role: string, name: string, children: readonly A11yNode[] = []): A11yNode => ({ role, name, children });
const text = (value: string): A11yNode => node('StaticText', value);

// The contact page as a browser reports it: a filled text field (its value only as text inside
// it), a paragraph, a button with a 200-character name, the declared secret and an email address.
const contactPage = (): A11yNode => node('document', 'Contact Lantern Books', [
  node('banner', '', [node('navigation', 'Main', [node('list', '', [
    node('listitem', '', [node('ListMarker', '• '), node('link', 'Home', [text('Home')])]),
  ])])]),
  node('main', '', [
    node('heading', 'Contact us', [text('Contact us')]),
    node('paragraph', '', [text(PARAGRAPH_TEXT)]),
    node('form', 'Contact form', [
      node('label', '', [text('Display name')]),
      node('textbox', 'Display name', [node('generic', '', [text(FIELD_VALUE)])]),
      node('generic', '', [node('button', LONG_NAME, [text(LONG_NAME)])]),
    ]),
    node('heading', `Office key: ${SECRET_VALUE}`, [text(`Office key: ${SECRET_VALUE}`)]),
    node('link', `Write to ${EMAIL}`, [text(`Write to ${EMAIL}`)]),
  ]),
]);

const contactEntry = (redact: Redactor = projectRedactor()): Promise<PageMapEntry> => pageMapEntry(contactPage(), PAGE_URL, 'Contact Lantern Books', 1, redact);
const names = (tree: readonly PageMapNode[]): readonly string[] => allNodes(tree).map((kept) => kept.name);
const shown = (entry: PageMapEntry): string => JSON.stringify(entry);
const leaf = (role: string, name: string): PageMapNode => ({ role, name, children: [] });

test('the contact page gives its path, title, depth and an outline of kept roles with their names', { criterion: 'AC-SPEC-37-04' }, async () => {
  const entry = await contactEntry();
  assert.deepEqual(entry, {
    path: '/contact.html',
    title: 'Contact Lantern Books',
    depth: 1,
    tree: [
      { role: 'banner', name: '', children: [{ role: 'navigation', name: 'Main', children: [{ role: 'list', name: '', children: [
        { role: 'listitem', name: '', children: [leaf('link', 'Home')] },
      ] }] }] },
      { role: 'main', name: '', children: [
        leaf('heading', 'Contact us'),
        { role: 'form', name: 'Contact form', children: [leaf('textbox', 'Display name'), leaf('button', LONG_NAME.slice(0, MAXIMUM_NAME_LENGTH))] },
        leaf('heading', `Office key: ${SECRET_PLACEHOLDER}`),
        leaf('link', defaultRedactor().text(`Write to ${EMAIL}`)),
      ] },
    ],
  });
});

test('the filled text field keeps its role and name, and its value is nowhere in the entry', { criterion: 'AC-SPEC-37-04' }, async () => {
  const entry = await contactEntry();
  assert.ok(allNodes(entry.tree).some((kept) => kept.role === 'textbox' && kept.name === 'Display name'), shown(entry));
  assert.equal(shown(entry).includes(FIELD_VALUE), false, 'the field value reached the page map');
});

test('the paragraph and every static text are dropped, so no paragraph text is in the entry', { criterion: 'AC-SPEC-37-04' }, async () => {
  const entry = await contactEntry();
  const roles = allNodes(entry.tree).map((kept) => kept.role);
  for (const dropped of ['paragraph', 'StaticText', 'generic', 'label', 'ListMarker', 'document']) assert.equal(roles.includes(dropped), false, `${dropped} was kept`);
  assert.equal(shown(entry).includes(PARAGRAPH_TEXT), false, 'paragraph text reached the page map');
});

test('counter-example: with no redaction and no role filter to hide it, the field value and paragraph text are what the browser reported', { criterion: 'AC-SPEC-37-04' }, () => {
  // The canaries are in the tree the entry is built from, so their absence above is the filter's doing.
  const reported = JSON.stringify(contactPage());
  assert.ok(reported.includes(FIELD_VALUE) && reported.includes(PARAGRAPH_TEXT));
});

test('a 200-character button name is cut to its first 80 characters', { criterion: 'AC-SPEC-37-04' }, async () => {
  assert.equal(LONG_NAME.length, 200);
  const entry = await contactEntry();
  const button = allNodes(entry.tree).find((kept) => kept.role === 'button');
  assert.equal(button?.name, LONG_NAME.slice(0, MAXIMUM_NAME_LENGTH));
  assert.ok(names(entry.tree).every((name) => name.length <= MAXIMUM_NAME_LENGTH), JSON.stringify(names(entry.tree)));
});

test('a name of exactly 80 characters is kept whole', { criterion: 'AC-SPEC-37-04' }, async () => {
  const exact = LONG_NAME.slice(0, MAXIMUM_NAME_LENGTH);
  const entry = await pageMapEntry(node('document', '', [node('button', exact)]), PAGE_URL, 'Short', 0, projectRedactor());
  assert.deepEqual(entry.tree, [leaf('button', exact)]);
});

test('neither the declared secret nor the email address is in the entry', { criterion: 'AC-SPEC-37-04' }, async () => {
  const entry = await contactEntry();
  assert.equal(shown(entry).includes(SECRET_VALUE), false, 'the declared secret reached the page map');
  assert.equal(shown(entry).includes(EMAIL), false, 'the email address reached the page map');
  assert.equal(shown(entry).includes('@'), false, 'part of the email address reached the page map');
});

test('counter-example: through a redactor that redacts nothing, the same page keeps the secret and the email', { criterion: 'AC-SPEC-37-04' }, async () => {
  const entry = await contactEntry(noRedaction);
  assert.ok(shown(entry).includes(SECRET_VALUE), 'the entry does not apply the redactor it is given');
  assert.ok(shown(entry).includes(EMAIL));
});

test('a name is redacted before it is cut, so an email address across the 80th character leaves nothing of itself', { criterion: 'AC-SPEC-37-04' }, async () => {
  // The address starts at character 70: cut first, "ada.lovela" would be left and no rule would match it.
  const name = `${'Write to the reading room team with any question you have, at '.padEnd(70, '.')}ada.lovelace@example.org today`;
  const entry = await pageMapEntry(node('document', '', [node('link', name)]), PAGE_URL, 'Contact', 0, projectRedactor());
  const kept = names(entry.tree)[0] ?? '';
  assert.ok(kept.length <= MAXIMUM_NAME_LENGTH, kept);
  assert.equal(kept.includes('ada.lovela'), false, `part of the address survived: ${kept}`);
  assert.equal(kept.includes('@'), false, kept);
});

test('a declared secret across the 80th character is redacted whole before the cut', { criterion: 'AC-SPEC-37-04' }, async () => {
  const name = `${'Your office key, kept for the reading room only, is'.padEnd(72, ' ')}${SECRET_VALUE}`;
  const entry = await pageMapEntry(node('document', '', [node('heading', name)]), PAGE_URL, 'Contact', 0, projectRedactor());
  const kept = names(entry.tree)[0] ?? '';
  assert.equal(kept.includes(SECRET_VALUE.slice(0, 8)), false, `the start of the secret survived: ${kept}`);
});

test('a title holding an email address or the declared secret is redacted too', { criterion: 'AC-SPEC-37-04' }, async () => {
  const entry = await pageMapEntry(node('document', '', []), PAGE_URL, `Messages for ${EMAIL} (${SECRET_VALUE})`, 2, projectRedactor());
  assert.equal(entry.title.includes(EMAIL), false, entry.title);
  assert.equal(entry.title.includes(SECRET_VALUE), false, entry.title);
});

test('the path keeps no query or fragment, so values in the address never reach the map', { criterion: 'AC-SPEC-37-04' }, async () => {
  const entry = await contactEntry();
  assert.equal(entry.path, '/contact.html');
  for (const part of ['newsletter', 'reader=ada', '#form', '?']) assert.equal(shown(entry).includes(part), false, `${part} is in the entry`);
});

test('every kept role is kept, with its name, in document order', { criterion: 'AC-SPEC-37-04' }, async () => {
  const tree = node('document', '', KEPT_ROLES.map((role) => node(role, `${role} name`)));
  const entry = await pageMapEntry(tree, PAGE_URL, 'Every role', 0, projectRedactor());
  assert.deepEqual(entry.tree, KEPT_ROLES.map((role) => leaf(role, `${role} name`)));
});

test('a node of a role not kept is dropped and its kept descendants take its place, in order', { criterion: 'AC-SPEC-37-04' }, async () => {
  for (const dropped of DROPPED_ROLES) {
    const tree = node('main', '', [
      node('heading', 'Before'),
      node(dropped, 'wrapper name', [node('button', 'First'), text('loose text'), node('generic', '', [node('link', 'Second')])]),
      node('heading', 'After'),
    ]);
    const entry = await pageMapEntry(tree, PAGE_URL, 'Wrapped', 0, projectRedactor());
    assert.deepEqual(entry.tree, [{ role: 'main', name: '', children: [
      leaf('heading', 'Before'), leaf('button', 'First'), leaf('link', 'Second'), leaf('heading', 'After'),
    ] }], `a ${dropped} wrapper`);
  }
});

test('the same tree, address and title give the same entry each time', { criterion: 'AC-SPEC-37-04' }, async () => {
  const first = await contactEntry();
  const second = await contactEntry();
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});
