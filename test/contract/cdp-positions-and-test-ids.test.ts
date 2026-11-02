// Positions and declared test-id attributes in a real browser, on the own CDP driver.
// A positioned locator takes the matches in document order and picks one: first, last or the nth.
// On a page with three of each (fixtures/plan-values-app/positions.html), every locator kind acts
// on, or reads, the expected one; a position past the last match is not-found, with nothing sent.
// A testId locator may name a declared attribute; the driver matches it by exact string equality
// and never builds a selector from plan text. On a page of look-alikes
// (fixtures/plan-values-app/test-ids.html), a test id holding selector syntax matches only the
// element whose attribute is exactly that text, and one that a built selector would widen to
// another element matches nothing and sends nothing.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { outcomes, type BrowserHarness } from '#test-support/browser/BrowserHarness.ts';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { click, fill, label, navigate, role, testId, text, textEquals, type JsonRecord } from '#test-support/browser/RawPlan.ts';
import { planValuesHarness } from './plan-values-support.ts';
import { shareBrowserInThisFile } from '#test-support/browser/ShareBrowserInThisFile.ts';

shareBrowserInThisFile();

let harness: BrowserHarness;
before(async () => { harness = await planValuesHarness(); });
after(async () => { await harness.close(); });

describe('positions on a page with three matches', () => {
  const OPEN_PAGE = navigate('/positions.html');

  const CLICKS: readonly { readonly name: string; readonly locator: JsonRecord; readonly expected: string }[] = [
    { name: 'the first button named "Open"', locator: role('button', 'Open', { position: 'first' }), expected: 'first' },
    { name: 'the last button named "Open"', locator: role('button', 'Open', { position: 'last' }), expected: 'third' },
    { name: 'button 2 named "Open"', locator: role('button', 'Open', { position: 2 }), expected: 'second' },
    { name: 'test id "open-order" 2', locator: testId('open-order', { position: 2 }), expected: 'second' },
    { name: 'the last text "Open"', locator: text('Open', { position: 'last' }), expected: 'third' },
  ];

  for (const clicked of CLICKS) {
    test(`a click on ${clicked.name} acts on the ${clicked.expected} button only`, async () => {
      const { result, atClose } = await harness.runSteps(BrowserTarget.Chrome, [
        OPEN_PAGE, click(clicked.locator), textEquals(testId('opened'), clicked.expected, 'positions.opened'),
      ], { read: ['open-clicks'] });
      assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
      assert.equal(atClose?.shown['open-clicks'], '1', 'exactly one button was clicked');
    });
  }

  test('a fill of the field labelled "Quantity" at position 2 fills the second field only', async () => {
    const { result } = await harness.runSteps(BrowserTarget.Chrome, [
      OPEN_PAGE, fill(label('Quantity', { position: 2 }), '5'), textEquals(testId('quantities'), '-,5,-', 'positions.second-quantity-filled'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('a check on a positioned locator reads the element at that position', async () => {
    const { result } = await harness.runSteps(BrowserTarget.Chrome, [
      OPEN_PAGE,
      textEquals(testId('order-row', { position: 'first' }), 'Row one', 'positions.first-row'),
      textEquals(testId('order-row', { position: 2 }), 'Row two', 'positions.second-row'),
      textEquals(testId('order-row', { position: 'last' }), 'Row three', 'positions.last-row'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('a click on button 4 of three fails with not-found and sends nothing', async () => {
    const { result, atClose } = await harness.runSteps(BrowserTarget.Chrome, [
      OPEN_PAGE, click(role('button', 'Open', { position: 4 })), textEquals(testId('opened'), 'none', 'positions.nothing-opened'),
    ], { read: ['input-events', 'opened'] });
    assert.equal(result.state, 'Failed');
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'not-found'], [2, 'skipped', undefined]]);
    assert.equal(atClose?.shown['input-events'], '0', 'no input event reached the page');
    assert.equal(atClose?.shown['opened'], 'none');
  });

  // Counter-example: without a position the same locator matches all three, so it is the
  // position that picks one.
  test('counter-example: the same locator without a position is ambiguous and sends nothing', async () => {
    const { result, atClose } = await harness.runSteps(BrowserTarget.Chrome, [
      OPEN_PAGE, click(role('button', 'Open')), textEquals(testId('opened'), 'none', 'positions.nothing-opened'),
    ]);
    assert.equal(result.steps[1]?.code, 'ambiguous', JSON.stringify(result.steps));
    assert.equal(atClose?.shown['input-events'], '0');
  });
});

describe('declared test-id attributes on a page of look-alikes', () => {
  const OPEN_PAGE = navigate('/test-ids.html');
  const qa = (id: string): JsonRecord => testId(id, { attribute: 'data-qa' });
  const clickAndCheck = (locator: JsonRecord, expected: string) => [OPEN_PAGE, click(locator), textEquals(testId('clicked'), expected, 'test-ids.clicked')];

  // Holds '"]', ',' and '*'.
  const SELECTOR_SYNTAX = 'save"], button, [data-qa*="';

  test('a test id holding "]", "," and "*" finds and clicks only the element whose data-qa is exactly that text', async () => {
    const { result, atClose } = await harness.runSteps(BrowserTarget.Chrome, [
      OPEN_PAGE,
      textEquals(qa(SELECTOR_SYNTAX), 'Exact selector text', 'test-ids.exact-found'),
      click(qa(SELECTOR_SYNTAX)),
      textEquals(testId('clicked'), 'exact-selector', 'test-ids.clicked'),
    ], { read: ['button-clicks'] });
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.equal(atClose?.shown['button-clicks'], '1', 'exactly one button was clicked');
  });

  // Built into [data-qa="…"], this test id would read [data-qa="nothing"], [data-qa="save"] and
  // match the Save button. Matched exactly, it matches nothing.
  test('a test id that a built selector would widen to the Save button matches nothing: not-found, nothing sent', async () => {
    const { result, atClose } = await harness.runSteps(BrowserTarget.Chrome, clickAndCheck(qa('nothing"], [data-qa="save'), 'none'), { read: ['input-events', 'clicked'] });
    assert.equal(result.state, 'Failed');
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'not-found'], [2, 'skipped', undefined]]);
    assert.equal(atClose?.shown['input-events'], '0', 'no input event reached the page');
    assert.equal(atClose?.shown['clicked'], 'none');
  });

  // Counter-example: the look-alike itself is clickable, so the not-found above is the exact match's doing.
  test('counter-example: the test id "save" clicks the Save button', async () => {
    const { result } = await harness.runSteps(BrowserTarget.Chrome, clickAndCheck(qa('save'), 'save'));
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('a test id holding a backslash clicks the element whose data-qa holds it, not its look-alike', async () => {
    const { result } = await harness.runSteps(BrowserTarget.Chrome, clickAndCheck(qa('a\\b'), 'backslash'));
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('the id attribute matches an id of "*" exactly', async () => {
    const { result } = await harness.runSteps(BrowserTarget.Chrome, clickAndCheck(testId('*', { attribute: 'id' }), 'star'));
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('without an attribute a test id matches data-testid; naming data-qa matches data-qa instead', async () => {
    const { result } = await harness.runSteps(BrowserTarget.Chrome, [
      OPEN_PAGE,
      click(testId('shared')), textEquals(testId('clicked'), 'by-testid', 'test-ids.default-attribute'),
      click(qa('shared')), textEquals(testId('clicked'), 'by-qa', 'test-ids.declared-attribute'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });
});
