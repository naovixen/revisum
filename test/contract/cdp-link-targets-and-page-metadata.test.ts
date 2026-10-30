// Link targets, head metadata and pages loaded with scripts off, in a real browser on the own
// CDP driver.
// hrefEquals compares a link's href resolved against the page's URL, and never follows it: the
// fixture server sees no request for the target, the page stays where it was and no input event
// reaches it (fixtures/page-states-app/links.html).
// head.html's server HTML sets og:title to "Spring sale (server)"; its script changes it to
// "Spring sale (rewritten)", counts itself in the page and asks the server for script-ran.txt.
// Loaded with scripts disabled, metaContent sees the server's value and no page script runs;
// loaded as usual, it sees the script's. Scripts stay off only until the next navigate.
// metaContent and canonicalUrl fail with assertion-failed on a page whose head has no such tag
// (bare-head.html); the counter-examples pass on head.html.
// See docs/specs/SPEC-31-page-states-metadata-downloads-and-tabs.md.
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import {
  CDP_TARGET, canonicalUrl, hrefEquals, metaContent, navigate, navigateWithoutScripts, outcomes, pageStatesHarness, role, testId,
  textEquals, type PageStatesHarness,
} from './page-states-support.ts';

let harness: PageStatesHarness;
before(async () => { harness = await pageStatesHarness(); });
after(async () => { await harness.close(); });

const SERVER_TITLE = 'Spring sale (server)';
const SCRIPT_TITLE = 'Spring sale (rewritten)';
const SCRIPT_BEACON = '/script-ran.txt';
const pathOf = (url: string | undefined): string => new URL(url ?? 'about:blank').pathname;

describe('hrefEquals on a link with a relative href', () => {
  const OPEN_LINKS = navigate('/links.html');
  // The paths a followed link would ask the server for.
  const LINK_TARGETS = ['/billing/fees.html', '/help/billing/fees.html', '/help/../billing/fees.html', '/guide.html'];
  const followed = (paths: readonly string[]): readonly string[] => paths.filter((path) => LINK_TARGETS.includes(path));

  test('passes against the href resolved on the page URL, given as an absolute URL, and follows no link', { criterion: 'AC-SPEC-31-03' }, async () => {
    const { result, atClose, requestedPaths } = await harness.runSteps(CDP_TARGET, [
      OPEN_LINKS,
      hrefEquals(role('link', 'Late fees'), `${harness.origin}/billing/fees.html?tab=2`, 'links.fees-target'),
      hrefEquals(role('link', 'Guide'), `${harness.origin}/guide.html`, 'links.guide-target'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.deepEqual(followed(requestedPaths), [], 'no link target was requested');
    assert.equal(pathOf(atClose?.url), '/links.html', 'the page stayed where it was');
    assert.equal(atClose?.shown['input-events'], '0', 'no input event reached the page');
  });

  test('passes against the resolved href given as a path starting with /', { criterion: 'AC-SPEC-31-03' }, async () => {
    const { result, requestedPaths } = await harness.runSteps(CDP_TARGET, [
      OPEN_LINKS, hrefEquals(role('link', 'Late fees'), '/billing/fees.html?tab=2', 'links.fees-path'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.deepEqual(followed(requestedPaths), []);
  });

  // The unresolved join of the page's folder and the attribute text, and a different query, are
  // not the link's target.
  for (const wrong of ['/help/billing/fees.html?tab=2', '/billing/fees.html?tab=3']) {
    test(`fails with assertion-failed against ${wrong}, and follows no link`, { criterion: 'AC-SPEC-31-03' }, async () => {
      const { result, atClose, requestedPaths } = await harness.runSteps(CDP_TARGET, [
        OPEN_LINKS, hrefEquals(role('link', 'Late fees'), `${harness.origin}${wrong}`, 'links.fees-wrong'), textEquals(testId('input-events'), '0', 'links.untouched'),
      ]);
      assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed'], [2, 'skipped', undefined]]);
      assert.deepEqual(followed(requestedPaths), []);
      assert.equal(pathOf(atClose?.url), '/links.html');
    });
  }
});

describe('metaContent after a navigate with and without scripts', () => {
  const OPEN_HEAD = '/head.html';

  test('with scripts disabled, metaContent sees the og:title the server sent and no page script runs', { criterion: 'AC-SPEC-31-04' }, async () => {
    const { result, requestedPaths } = await harness.runSteps(CDP_TARGET, [
      navigateWithoutScripts(OPEN_HEAD),
      metaContent('og:title', SERVER_TITLE, 'head.server-title'),
      textEquals(testId('script-runs'), '0', 'head.no-script-ran'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.ok(requestedPaths.includes(OPEN_HEAD), 'the page was loaded');
    assert.ok(!requestedPaths.includes(SCRIPT_BEACON), 'no page script asked the server for anything');
  });

  test('without scripts disabled, metaContent sees the og:title the page script wrote, and both page scripts ran', { criterion: 'AC-SPEC-31-04' }, async () => {
    const { result, requestedPaths } = await harness.runSteps(CDP_TARGET, [
      navigate(OPEN_HEAD),
      metaContent('og:title', SCRIPT_TITLE, 'head.script-title'),
      textEquals(testId('script-runs'), '2', 'head.scripts-ran'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.ok(requestedPaths.includes(SCRIPT_BEACON), 'the page script asked the server for its beacon');
  });

  // The two pairs below are the same check with the other run's value: each fails, so the
  // passes above are not constants of the page.
  test('with scripts disabled, metaContent expecting the script\'s og:title fails with assertion-failed', { criterion: 'AC-SPEC-31-04' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [navigateWithoutScripts(OPEN_HEAD), metaContent('og:title', SCRIPT_TITLE, 'head.script-title')]);
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed']]);
  });

  test('without scripts disabled, metaContent expecting the server\'s og:title fails with assertion-failed', { criterion: 'AC-SPEC-31-04' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [navigate(OPEN_HEAD), metaContent('og:title', SERVER_TITLE, 'head.server-title')]);
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed']]);
  });

  test('scripts stay off only until the next navigate, which runs the page scripts again', { criterion: 'AC-SPEC-31-04' }, async () => {
    const { result, requestedPaths } = await harness.runSteps(CDP_TARGET, [
      navigateWithoutScripts(OPEN_HEAD),
      metaContent('og:title', SERVER_TITLE, 'head.server-title'),
      navigate(OPEN_HEAD),
      metaContent('og:title', SCRIPT_TITLE, 'head.script-title'),
      textEquals(testId('script-runs'), '2', 'head.scripts-ran'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
    assert.equal(requestedPaths.filter((path) => path === SCRIPT_BEACON).length, 1, 'page scripts ran on the second load only');
  });
});

describe('metaContent and canonicalUrl on a head without the tag', () => {
  test('metaContent fails with assertion-failed when no meta tag has the name', { criterion: 'AC-SPEC-31-05' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      navigate('/bare-head.html'), metaContent('description', 'Garden tools at half price.', 'head.description'), textEquals(testId('input-events'), '0', 'head.shown'),
    ]);
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed'], [2, 'skipped', undefined]]);
  });

  // The page's own URL is not its canonical URL when the head names none.
  test('canonicalUrl fails with assertion-failed when the head has no canonical link, even against the page\'s own URL', { criterion: 'AC-SPEC-31-05' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      navigate('/bare-head.html'), canonicalUrl(`${harness.origin}/bare-head.html`, 'head.canonical'), textEquals(testId('input-events'), '0', 'head.shown'),
    ]);
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed'], [2, 'skipped', undefined]]);
  });

  test('metaContent with a matching name but different content fails with assertion-failed', { criterion: 'AC-SPEC-31-05' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [navigate('/head.html'), metaContent('description', 'Garden tools at full price.', 'head.description')]);
    assert.deepEqual(outcomes(result), [[0, 'passed', undefined], [1, 'failed', 'assertion-failed']]);
  });

  // Counter-example: on head.html both tags are there, and the canonical link's relative href is
  // compared resolved.
  test('counter-example: on a head with both tags, metaContent and canonicalUrl pass', { criterion: 'AC-SPEC-31-05' }, async () => {
    const { result } = await harness.runSteps(CDP_TARGET, [
      navigate('/head.html'),
      metaContent('description', 'Garden tools at half price.', 'head.description'),
      canonicalUrl(`${harness.origin}/head.html?view=canonical`, 'head.canonical'),
    ]);
    assert.equal(result.state, 'Passed', JSON.stringify(result.steps));
  });
});
