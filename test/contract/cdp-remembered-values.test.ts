// Remembered values in a real browser, on the own CDP driver. A remember step reads one element's
// text or input value through the driver's probe, waiting as a check waits, with whitespace
// normalised; later steps use it by name. Text that is empty, looks like script or is longer than
// the project's maximumTextLength fails the step with value-empty, value-unsafe or value-too-long:
// the run ends Failed there and no later step sends input. The fixture page
// (fixtures/plan-values-app/remember.html) counts every input event, whoever sends it.
// A remembered value used as a path segment stays one whole segment on the base URL's origin,
// however hostile its text; one of "." or ".." fails the navigate step before any request.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { outcomes, type BrowserHarness } from '#test-support/browser/BrowserHarness.ts';
import { BrowserTarget } from '#test-support/browser/BrowserTarget.ts';
import { click, fill, label, navigate, pathStartsWith, reference, remember, role, testId, textEquals, valueEquals } from '#test-support/browser/RawPlan.ts';
import type { FixtureRoute } from '#test-support/fixture-server.ts';
import { planValuesHarness } from './plan-values-support.ts';
import { shareBrowserInThisFile } from '#test-support/browser/ShareBrowserInThisFile.ts';

shareBrowserInThisFile();

let harness: BrowserHarness;
before(async () => { harness = await planValuesHarness(); });
after(async () => { await harness.close(); });

const OPEN_PAGE = navigate('/remember.html');
// What follows the remember step: a click, a fill that uses the value, and a check of the click.
const AFTER_REMEMBER = [
  click(role('button', 'Save')),
  fill(label('Search'), reference('remembered')),
  textEquals(testId('save-clicks'), '1', 'remember.saved'),
];
const READ_AT_CLOSE = ['input-events', 'save-clicks'];

describe('a remember step whose text cannot be used', () => {
  const REFUSED = [
    { what: 'empty text', element: 'empty-value', code: 'value-empty' },
    { what: 'text of spaces only', element: 'blank-value', code: 'value-empty' },
    { what: 'a javascript: URL', element: 'script-value', code: 'value-unsafe' },
    { what: 'a script tag shown as text', element: 'markup-value', code: 'value-unsafe' },
    { what: '501 characters, one over maximumTextLength', element: 'long-value', code: 'value-too-long' },
  ] as const;

  for (const refused of REFUSED) {
    test(`remembering ${refused.what} fails the step with ${refused.code}, ends the run Failed there and sends no later input`, async () => {
      const { result, atClose } = await harness.runSteps(BrowserTarget.Chrome, [OPEN_PAGE, remember('remembered', testId(refused.element)), ...AFTER_REMEMBER], { read: READ_AT_CLOSE });
      assert.equal(result.state, 'Failed');
      assert.deepEqual(outcomes(result), [
        [0, 'passed', undefined], [1, 'failed', refused.code], [2, 'skipped', undefined], [3, 'skipped', undefined], [4, 'skipped', undefined],
      ]);
      assert.equal(atClose?.shown['input-events'], '0', 'no input event reached the page');
      assert.equal(atClose.shown['save-clicks'], '0');
    });
  }
});

describe('a remember step whose text can be used', () => {
  // Counter-example to every refusal above: the same plan reading usable text sends the later
  // input, so the page's counters can move.
  test('the order number is remembered without its surrounding whitespace, and the later steps run', async () => {
    const { result, atClose } = await harness.runSteps(BrowserTarget.Chrome, [
      OPEN_PAGE, remember('remembered', testId('order-number')), ...AFTER_REMEMBER,
      valueEquals(label('Search'), 'ORD-58213', 'remember.search-filled'),
      textEquals(testId('order-number'), reference('remembered'), 'remember.order-number-shown'),
    ], { read: READ_AT_CLOSE });
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.equal(atClose?.shown['save-clicks'], '1');
    assert.notEqual(atClose.shown['input-events'], '0', 'the later steps sent input');
  });

  test('an input\'s value is remembered with read "value"', async () => {
    const { result } = await harness.runSteps(BrowserTarget.Chrome, [
      OPEN_PAGE, remember('reference', label('Reference'), 'value'), fill(label('Search'), reference('reference')),
      valueEquals(label('Search'), 'REF-7731', 'remember.reference-copied'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });

  test('a remember step waits for text that appears after the page loads', async () => {
    const { result } = await harness.runSteps(BrowserTarget.Chrome, [
      OPEN_PAGE, remember('late', testId('late-value')), fill(label('Search'), reference('late')),
      valueEquals(label('Search'), 'LATE-4471', 'remember.late-value-copied'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });
});

describe('a remembered value as a path segment', () => {
  const HOSTILE = 'a/b?c#d %2F ../名前';
  // Only this path is answered with a page: a value that left its segment reaches an empty 404, which
  // the browser shows as its own error page, so the check of the URL fails.
  const itemPath = `/items/${encodeURIComponent(HOSTILE)}/detail`;
  const itemPage: FixtureRoute = () => ({
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Item</title></head><body><main>Item</main></body></html>',
  });
  let harnessWithItemPage: BrowserHarness;
  before(async () => { harnessWithItemPage = await planValuesHarness(new Map([[itemPath, itemPage]])); });
  after(async () => { await harnessWithItemPage.close(); });

  test('a value holding "/", "?", "#", "%2F", ".." and non-Latin text stays one segment and one query value on the base URL\'s origin', async () => {
    const { result, atClose, requestedPaths } = await harnessWithItemPage.runSteps(BrowserTarget.Chrome, [
      OPEN_PAGE, remember('segment', testId('hostile-segment')),
      navigate({ segments: ['items', reference('segment'), 'detail'], query: { search: reference('segment') } }),
      pathStartsWith('/items/', 'remember.items-page-opened'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    const itemPaths = requestedPaths.filter((path) => path.startsWith('/items/'));
    assert.equal(itemPaths.length, 1, `the server was asked for one items path: ${JSON.stringify(requestedPaths)}`);
    const segments = (itemPaths[0] ?? '').split('/').slice(1);
    assert.equal(segments.length, 3, `exactly the template's three segments: ${itemPaths[0] ?? ''}`);
    assert.equal(segments[0], 'items');
    assert.equal(decodeURIComponent(segments[1] ?? ''), HOSTILE, 'the value is one whole segment');
    assert.equal(segments[2], 'detail');
    assert.ok(atClose !== null, 'the page was read at close');
    const url = new URL(atClose.url);
    assert.equal(url.origin, harnessWithItemPage.origin, 'the browser stayed on the base URL\'s origin');
    assert.equal(url.searchParams.get('search'), HOSTILE, 'the value is one whole query value');
    assert.equal(url.hash, '', 'no value starts a fragment');
  });

  for (const [what, element] of [['"."', 'dot-segment'], ['".."', 'dot-dot-segment']] as const) {
    test(`a value of ${what} fails the navigate step with value-unsafe before any request`, async () => {
      const { result, atClose, requestedPaths } = await harness.runSteps(BrowserTarget.Chrome, [
        OPEN_PAGE, remember('segment', testId(element)),
        navigate({ segments: ['items', reference('segment')] }),
        pathStartsWith('/items', 'remember.items-page-opened'),
      ]);
      assert.equal(result.state, 'Failed');
      assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'passed', undefined], [2, 'failed', 'value-unsafe'], [3, 'skipped', undefined]]);
      assert.deepEqual(requestedPaths.filter((path) => path !== '/remember.html' && !path.endsWith('.js') && path !== '/favicon.ico'), [], 'no navigation reached the server');
      assert.equal(new URL(atClose?.url ?? 'about:blank').pathname, '/remember.html', 'the page never left');
    });
  }
});
