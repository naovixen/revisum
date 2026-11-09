// The crawl (engine's crawlSite, with the driver injected): breadth first from the start page at
// depth 0. A page's link targets are kept when they are on the start origin; each is reduced to its
// path (no query or fragment), de-duplicated against every path already seen, and queued in sorted
// order. Pages are opened at origin plus path. At most maximumPages pages, none deeper than maximumDepth;
// truncated is true exactly when a same-origin path was left unvisited because of a bound, or was left
// out because it loaded and then could not be read. A page other than the start page that fails to
// load is left out and not counted, and truncates nothing; a start page that fails gives
// explore-start-unreachable. The crawl only navigates and reads: it never clicks,
// types, selects, submits or runs page scripts.
//
// The site is held in memory (explore-examples.ts) and the driver is a spy that records every call
// made on it, including calls of methods the port does not have. Each negative test runs the
// mutant crawl followEveryLink() against the same site, to show its check fails for a crawl that
// does what the spec forbids.
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { canonicalJson, type TrustedProject } from '@revisum/engine';
import { trustedProjectFrom } from '../../../support/builders/ClearRun.ts';
import {
  CRAWL_METHODS, PRODUCTION_ORIGIN, SECOND_ORIGIN, START_ORIGIN, UNDECLARED_ORIGIN,
  at, crawlProjectFile, crawlSite, fakeSite, followEveryLink, optionsFor, spyExploreDriver,
  type CrawlOutcome, type FakePage, type FakeSite, type PageMap,
} from './examples/CrawlOutcome.ts';

let project: TrustedProject;
before(async () => { project = await trustedProjectFrom(crawlProjectFile()); });

const page = (title: string, links: readonly string[], extra: Partial<FakePage> = {}): FakePage => ({ title, links, ...extra });

// The book shop: nine pages on the start origin, up to depth 4, and links to every other kind of
// origin. Each origin has a page at every linked path, so a crawl that followed a link off the start
// origin would load it. Per page, links are listed out of order and with queries and fragments.
const SHOP: Readonly<Record<string, FakePage>> = {
  [at('/')]: page('Lantern Books', [
    at('/pricing.html?plan=reader#compare'), at('/about.html'), at('/notes.html'), at('/contact.html'), at('/about.html#history'),
    at('/partner.html', SECOND_ORIGIN), at('/checkout', PRODUCTION_ORIGIN), at('/elsewhere.html', UNDECLARED_ORIGIN),
    'https://127.0.0.1:4310/secure.html', 'http://localhost:4310/alias.html',
  ]),
  [at('/about.html')]: page('About', [at('/'), at('/team.html'), at('/contact.html')]),
  [at('/contact.html')]: page('Contact', [at('/')]),
  [at('/notes.html')]: page('Notes', [at('/'), at('/checkout', PRODUCTION_ORIGIN)]),
  [at('/pricing.html')]: page('Pricing', [at('/faq.html'), at('/')]),
  [at('/team.html')]: page('Team', [at('/careers.html')]),
  [at('/faq.html')]: page('Questions', [at('/')]),
  [at('/careers.html')]: page('Careers', [at('/archive.html')]),
  [at('/archive.html')]: page('Archive', []),
  // Pages a crawl must never open.
  [at('/partner.html', SECOND_ORIGIN)]: page('Partner', []),
  [at('/checkout', PRODUCTION_ORIGIN)]: page('Checkout', []),
  [at('/elsewhere.html', UNDECLARED_ORIGIN)]: page('Elsewhere', []),
  ['https://127.0.0.1:4310/secure.html']: page('Secure', []),
  ['http://localhost:4310/alias.html']: page('Alias', []),
};
const site = (): FakeSite => fakeSite(SHOP);

// The whole site in crawl order: breadth first, each page's new paths queued in sorted order.
// Level 2 is /team.html (queued by /about.html) before /faq.html (queued by /pricing.html).
const FULL_ORDER: readonly (readonly [string, number])[] = [
  ['/', 0], ['/about.html', 1], ['/contact.html', 1], ['/notes.html', 1], ['/pricing.html', 1],
  ['/team.html', 2], ['/faq.html', 2], ['/careers.html', 3], ['/archive.html', 4],
];

const crawl = async (spySite: FakeSite = site(), bounds: Parameters<typeof optionsFor>[1] = { maximumPages: 100, maximumDepth: 5 }, start = at('/')) => {
  const spy = spyExploreDriver(spySite);
  const outcome = await crawlSite(spy.driver, project, optionsFor(start, bounds));
  return { spy, outcome };
};

const mapOf = (outcome: CrawlOutcome): PageMap => {
  if (!outcome.ok) {assert.fail(`the crawl failed with ${outcome.code}`);}
  return outcome.map;
};
const visited = (map: PageMap): readonly (readonly [string, number])[] => map.pages.map((entry) => [entry.path, entry.depth] as const);
const offStart = (urls: readonly string[]): readonly string[] => urls.filter((url) => new URL(url).origin !== START_ORIGIN);

// ---- Origins ---------------------------------------------------------------------------------------

test('the crawl opens only pages on the start origin, whatever origins the pages link to', async () => {
  const { spy, outcome } = await crawl();
  mapOf(outcome);
  assert.ok(spy.navigations().length > 0, 'the crawl opened no page');
  assert.deepEqual(offStart(spy.navigations()), []);
});

test('counter-example: a crawl that follows every link opens the declared, production, undeclared and look-alike origins', async () => {
  const spy = spyExploreDriver(site());
  await followEveryLink(spy.driver, at('/'), 100);
  const opened = new Set(offStart(spy.navigations()).map((url) => new URL(url).origin));
  assert.deepEqual([...opened].sort(), [PRODUCTION_ORIGIN, SECOND_ORIGIN, UNDECLARED_ORIGIN, 'http://localhost:4310', 'https://127.0.0.1:4310'].sort());
});

test('the page map holds the start origin and no page of another origin', async () => {
  const map = mapOf((await crawl()).outcome);
  assert.equal(map.origin, START_ORIGIN);
  for (const path of ['/partner.html', '/checkout', '/elsewhere.html', '/secure.html', '/alias.html']) {
    assert.equal(map.pages.some((entry) => entry.path === path), false, `${path} of another origin is in the map`);
  }
});

for (const { name, start } of [
  { name: 'a production origin', start: at('/', PRODUCTION_ORIGIN) },
  { name: 'an undeclared origin', start: at('/', UNDECLARED_ORIGIN) },
]) {
  test(`a start URL on ${name} is refused with explore-origin-refused, before any driver call`, async () => {
    const { spy, outcome } = await crawl(site(), {}, start);
    assert.deepEqual(outcome, { ok: false, code: 'explore-origin-refused' });
    assert.deepEqual(spy.calls, []);
  });
}

test('counter-example: a start URL on the second declared, non-production origin is crawled there', async () => {
  const { spy, outcome } = await crawl(site(), {}, at('/partner.html', SECOND_ORIGIN));
  const map = mapOf(outcome);
  assert.equal(map.origin, SECOND_ORIGIN);
  assert.deepEqual(spy.navigations(), [at('/partner.html', SECOND_ORIGIN)]);
});

// ---- Navigation and reads only ---------------------------------------------------------------------

test('the crawl makes only navigation, page, accessibility-tree and link-target calls', async () => {
  const { spy, outcome } = await crawl();
  mapOf(outcome);
  const methods = new Set(spy.calls.map((call) => call.method));
  assert.deepEqual([...methods].filter((method) => !CRAWL_METHODS.includes(method)), [], JSON.stringify(spy.calls));
  // Each page opened is read: its title, its tree and its links.
  for (const method of CRAWL_METHODS) {assert.ok(methods.has(method), `the crawl never called ${method}`);}
});

test('counter-example: the spy records a click that a crawl makes, though the port has no such method', async () => {
  const spy = spyExploreDriver(site());
  await followEveryLink(spy.driver, at('/'), 3);
  assert.ok(spy.calls.some((call) => call.method === 'act'), JSON.stringify(spy.calls));
});

test('the crawl opens each page once, at origin plus path, with no query or fragment', async () => {
  const { spy } = await crawl();
  const opened = spy.navigations();
  assert.equal(new Set(opened).size, opened.length, `a page was opened twice: ${JSON.stringify(opened)}`);
  for (const url of opened) {
    const parsed = new URL(url);
    assert.equal(url, `${parsed.origin}${parsed.pathname}`, `${url} was opened with a query or fragment`);
  }
});

// ---- Order and bounds --------------------------------------------------------------------------

test('a crawl with room for the whole site visits it breadth first, each page\'s links in sorted order, and is not truncated', async () => {
  const map = mapOf((await crawl()).outcome);
  assert.deepEqual(visited(map), FULL_ORDER);
  assert.equal(map.truncated, false);
});

test('the default bounds, 20 pages and depth 3, leave the depth-4 archive out and mark the map truncated', async () => {
  const map = mapOf((await crawl(site(), { maximumPages: 20, maximumDepth: 3 })).outcome);
  assert.deepEqual(visited(map), FULL_ORDER.filter(([, depth]) => depth <= 3));
  assert.equal(map.truncated, true);
});

// Every pair of bounds up to beyond the site's size: the crawl holds the first maximumPages pages of the
// whole crawl that are no deeper than maximumDepth, and is truncated exactly when that leaves one out.
for (let maximumDepth = 0; maximumDepth <= 5; maximumDepth++) {
  test(`with depth at most ${maximumDepth}, every page bound from 1 to 10 gives the bounded prefix of the whole crawl`, async () => {
    for (let maximumPages = 1; maximumPages <= 10; maximumPages++) {
      const map = mapOf((await crawl(site(), { maximumPages, maximumDepth })).outcome);
      const expected = FULL_ORDER.filter(([, depth]) => depth <= maximumDepth).slice(0, maximumPages);
      assert.deepEqual(visited(map), expected, `maximumPages ${maximumPages}, maximumDepth ${maximumDepth}`);
      assert.ok(map.pages.length <= maximumPages && map.pages.every((entry) => entry.depth <= maximumDepth));
      assert.equal(map.truncated, expected.length < FULL_ORDER.length, `truncated, with maximumPages ${maximumPages} and maximumDepth ${maximumDepth}`);
    }
  });
}

test('a page bound equal to the site\'s size is not truncated, and one less is', async () => {
  assert.equal(mapOf((await crawl(site(), { maximumPages: FULL_ORDER.length, maximumDepth: 5 })).outcome).truncated, false);
  assert.equal(mapOf((await crawl(site(), { maximumPages: FULL_ORDER.length - 1, maximumDepth: 5 })).outcome).truncated, true);
});

test('a depth bound equal to the deepest page is not truncated, and one less is', async () => {
  assert.equal(mapOf((await crawl(site(), { maximumPages: 100, maximumDepth: 4 })).outcome).truncated, false);
  assert.equal(mapOf((await crawl(site(), { maximumPages: 100, maximumDepth: 3 })).outcome).truncated, true);
});

test('a linked page that fails to load is left out, not counted against maximumPages, opened once, and truncates nothing', async () => {
  const broken = fakeSite({
    [at('/')]: page('Home', [at('/b-broken.html'), at('/a.html'), at('/c.html')]),
    [at('/a.html')]: page('A', [at('/b-broken.html')]),
    [at('/b-broken.html')]: page('Broken', [], { fails: true }),
    [at('/c.html')]: page('C', []),
  });
  const whole = await crawl(broken);
  const map = mapOf(whole.outcome);
  assert.deepEqual(visited(map), [['/', 0], ['/a.html', 1], ['/c.html', 1]]);
  assert.equal(map.truncated, false);
  assert.equal(whole.spy.navigations().filter((url) => url.endsWith('/b-broken.html')).length, 1);
  // Three loaded pages fill a bound of three: the broken one did not take a place.
  const bounded = mapOf((await crawl(broken, { maximumPages: 3, maximumDepth: 5 })).outcome);
  assert.deepEqual(visited(bounded), [['/', 0], ['/a.html', 1], ['/c.html', 1]]);
});

test('a start page that fails to load gives explore-start-unreachable', async () => {
  const unreachable = fakeSite({ [at('/')]: page('Home', [at('/a.html')], { fails: true }), [at('/a.html')]: page('A', []) });
  const { outcome } = await crawl(unreachable);
  assert.deepEqual(outcome, { ok: false, code: 'explore-start-unreachable' });
});

// ---- The same site gives the same map ----------------------------------------------------------------

test('two crawls of the same site give byte-identical page maps', async () => {
  const first = mapOf((await crawl()).outcome);
  const second = mapOf((await crawl()).outcome);
  assert.equal(canonicalJson(second), canonicalJson(first));
});

// The same site with each page's links in reverse order, each written again with a query and a
// fragment, and listed twice.
const reshuffled = (): FakeSite => fakeSite(Object.fromEntries(Object.entries(SHOP).map(([url, shown]) => [url, {
  ...shown,
  links: [...shown.links].reverse().flatMap((link) => [link, `${link.split('#')[0]?.split('?')[0] ?? link}?utm_source=crawl#top`]),
}])));

test('the same site with its links in another order, repeated, and with queries and fragments gives a byte-identical page map', async () => {
  const original = mapOf((await crawl(site(), { maximumPages: 20, maximumDepth: 3 })).outcome);
  const shuffled = mapOf((await crawl(reshuffled(), { maximumPages: 20, maximumDepth: 3 })).outcome);
  assert.equal(canonicalJson(shuffled), canonicalJson(original));
});

test('counter-example: a site with one title changed gives a different page map', async () => {
  const changed = fakeSite({ ...SHOP, [at('/faq.html')]: page('Questions and answers', [at('/')]) });
  const original = mapOf((await crawl()).outcome);
  const other = mapOf((await crawl(changed)).outcome);
  assert.notEqual(canonicalJson(other), canonicalJson(original));
});
