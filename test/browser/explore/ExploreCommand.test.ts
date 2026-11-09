// Explore mode of the draft command: `revisum draft --explore <url> [--from <spec.md>]
// [--after <approved.plan>] [--max-pages 20] [--max-depth 3] [--host] --out plans/<name>.plan [--json]`.
// A deterministic crawl, with no AI, reads the fixture site's pages through the CDP driver, always
// headless; the planner sees only the criteria (if any), the grammar version, the declared origins
// and targets, and the bounded, redacted page map; its text is admitted as an unapproved draft with
// source explore-draft and written after a fixed notice, with its errors and locator warnings by
// line. The start must be on a declared, non-production origin, and the crawl runs in the isolated
// runner unless --host is given.
//
// Each test runs the real command against the Lantern Books fixture site and a fake planner on
// loopback replaying a recorded response (explore-command-examples.ts), in host mode with a spy on
// the real browser, or with a fake isolated runner. The hostile page and draft are in
// test/proofs/runs/ExploreHostilePage.test.ts.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CLI_OUTPUT_SCHEMA } from '@revisum/cli';
import { failure } from '@revisum/engine';
import { sessionWith, wrappingSessions } from '#test-support/browser/driver/WrappingSessions.ts';
import { jsonAnswer } from '../../unit/runner/support/LocalService.ts';
import { CRITERION_TEXTS, EARLIER_ARTEFACT, EARLIER_ARTEFACT_MARK, GRAMMAR_VERSION, SPEC_PATH, replyWithContent, replyWithoutText } from '../../unit/cli/commands/examples/DraftCommand.ts';
import {
  ACTING_CALLS, AFTER_PLAN_PATH, BEYOND_DEFAULT_DEPTH, CANARIES, CRAWL_CALLS, DEFAULT_CRAWL, DRAFT_OUT, GOLDEN_EXPLORE_DRAFT, GOLDEN_OUTPUT,
  GOLDEN_PAGE_MAP, HOME_LINK_FRAGMENT, HOME_LINK_QUERY, HOME_PARAGRAPH, LONG_BUTTON_NAME, NOTICE, NOTICE_LINES, OFFICE_KEY_VALUE,
  OUTPUT_PLANNER_PLACEHOLDER, OUTPUT_REFERENCE_PLACEHOLDER, OUTPUT_SITE_PLACEHOLDER, PAGE_MAP_OUT, PLANNER_DRAFT, PRODUCTION_ORIGIN,
  SIGN_IN_PLAN, SITE_PLACEHOLDER, TARGET_ID, UNDECLARED_ORIGIN, UPKEEP_CALLS,
  allWrittenNodes, approvalOfPlan, containerPageMap, crawlOrder, draftText, everythingExplored, exploreArguments, exploreData,
  exploreDraftWithLine, exploreErrorCodes, spyBrowser, watchedFakeRunner, pageMapReference, pageMapText, plannerRequestTexts, writtenMap,
  withExploreRun, type ExploreRun, type ExploreSetup, type SessionCall,
} from './examples/ExploreCommandPorts.ts';
import { shareBrowserInThisFile } from '#test-support/browser/ShareBrowserInThisFile.ts';
import { AuditEventKind, GuaranteeLevel } from '@revisum/contracts';

shareBrowserInThisFile();

const home = (site: { readonly origin: string }): string => `${site.origin}/`;
const hostRun = (extra: readonly string[] = []): ExploreSetup => ({ argv: (site) => exploreArguments(home(site), ['--host', '--json', ...extra]) });

const eventKinds = (run: ExploreRun): readonly string[] => run.events.recorded.map((recorded) => recorded.event.kind);
const methods = (calls: readonly SessionCall[]): readonly string[] => calls.map((call) => call.method);

// The run stopped before anything was crawled, called or written.
function assertStoppedEarly(run: ExploreRun, code: string): void {
  assert.deepEqual(exploreErrorCodes(run), [code], run.outcome.stdout);
  assert.notEqual(run.outcome.exitCode, 0);
  assert.deepEqual(run.browser?.opened ?? [], [], 'a browser session was opened');
  assert.deepEqual(run.runner?.started ?? [], [], 'the isolated runner was started');
  assert.equal(run.planner.received.length, 0, 'the planner was called');
  assert.equal(run.workspace.exists(DRAFT_OUT), false, 'a draft was written');
  assert.equal(run.workspace.exists(PAGE_MAP_OUT), false, 'a page map was written');
}

// ---- Origins ----------------------------------------------------------------------

for (const { name, start } of [
  { name: 'a production origin', start: () => `${PRODUCTION_ORIGIN}/` },
  { name: 'an undeclared origin', start: () => `${UNDECLARED_ORIGIN}/` },
]) {
  test(`a start URL on ${name} stops with explore-origin-refused before any browser starts`, async () => {
    await withExploreRun({ argv: () => exploreArguments(start(), ['--host', '--json']) }, (run) => assertStoppedEarly(run, 'explore-origin-refused'));
  });

  test(`a start URL on ${name} stops with explore-origin-refused before the isolated runner starts`, async () => {
    await withExploreRun({
      argv: () => exploreArguments(start(), ['--json']),
      runner: (site) => watchedFakeRunner({ level: GuaranteeLevel.Isolated, output: containerPageMap(site.origin).printed }),
    }, (run) => assertStoppedEarly(run, 'explore-origin-refused'));
  });
}

test('counter-example: a start URL on the site\'s declared, non-production origin is crawled', async () => {
  await withExploreRun(hostRun(), (run) => {
    assert.deepEqual(exploreErrorCodes(run), [], run.outcome.stdout);
    assert.equal(writtenMap(run).origin, run.site.origin);
  });
});

test('the crawl never follows a link to another origin: the second origin and production are never requested', async () => {
  await withExploreRun(hostRun(), (run) => {
    const navigations = run.browser?.navigations() ?? [];
    assert.ok(navigations.length > 0, 'the crawl opened no page');
    assert.deepEqual(navigations.filter((url) => new URL(url).origin !== run.site.origin), []);
    assert.deepEqual(run.site.secondRequested, [], 'the second origin was asked for a page');
    const paths = writtenMap(run).pages.map((page) => page.path);
    for (const foreign of ['/partner.html', '/checkout']) assert.equal(paths.includes(foreign), false, `${foreign} is in the page map`);
  });
});

test('counter-example: the home page does link to the second origin, and that server records any request made of it', async () => {
  await withExploreRun(hostRun(), async (run) => {
    const homePage = await (await fetch(home(run.site))).text();
    assert.ok(homePage.includes(`${run.site.secondOrigin}/partner.html`), 'the home page has no link to the second origin');
    assert.ok(homePage.includes(`${PRODUCTION_ORIGIN}/checkout`), 'the home page has no link to production');
    await fetch(`${run.site.secondOrigin}/partner.html`);
    assert.deepEqual(run.site.secondRequested, ['/partner.html']);
  });
});

// ---- Navigation and reads only ------------------------------------------------------

test('without --after, the browser spy records only navigation, page, accessibility-tree and link-target calls', async () => {
  await withExploreRun(hostRun(), (run) => {
    const recorded = methods(run.browser?.calls ?? []);
    assert.deepEqual(recorded.filter((method) => !CRAWL_CALLS.includes(method) && !UPKEEP_CALLS.includes(method)), [], JSON.stringify(recorded));
    for (const method of CRAWL_CALLS) assert.ok(recorded.includes(method), `the crawl never called ${method}`);
  });
});

test('without --after, no click, typing, selection, upload, key press, dialog answer or page script reaches the browser', async () => {
  await withExploreRun(hostRun(), (run) => {
    const recorded = methods(run.browser?.calls ?? []);
    assert.ok(recorded.includes('navigate'), `the crawl opened no page: ${run.outcome.stdout}`);
    assert.deepEqual(recorded.filter((method) => ACTING_CALLS.includes(method) || method.includes('.')), []);
  });
});

test('with an approved --after plan, the only acting calls are the plan\'s, and all come before the crawl reads its first links', async () => {
  await withExploreRun({
    argv: (site) => exploreArguments(home(site), ['--after', AFTER_PLAN_PATH, '--host', '--json']),
    files: { [AFTER_PLAN_PATH]: SIGN_IN_PLAN },
    approvals: async (project) => [await approvalOfPlan(SIGN_IN_PLAN, project)],
  }, (run) => {
    const recorded = methods(run.browser?.calls ?? []);
    const firstLinks = recorded.indexOf('linkTargets');
    assert.ok(firstLinks !== -1, `the crawl never read links: ${JSON.stringify(recorded)}`);
    // The sign-in plan types its name and clicks Sign in: two actions, made before the crawl.
    assert.equal(recorded.slice(0, firstLinks).filter((method) => method === 'act').length, 2, JSON.stringify(recorded));
    const crawlCalls = recorded.slice(firstLinks);
    assert.deepEqual(crawlCalls.filter((method) => !CRAWL_CALLS.includes(method) && !UPKEEP_CALLS.includes(method)), [], JSON.stringify(crawlCalls));
  });
});

// ---- Bounds and order -------------------------------------------------------------

test('with the default bounds, the page map holds the site breadth first in sorted order, to depth 3, and is truncated', async () => {
  await withExploreRun(hostRun(), (run) => {
    const map = writtenMap(run);
    assert.deepEqual(crawlOrder(map), DEFAULT_CRAWL);
    assert.equal(map.truncated, true, 'the depth-4 archive was left out, so the crawl was truncated');
  });
});

test('--max-depth 4 reaches the archive and, with the whole site crawled, is not truncated', async () => {
  await withExploreRun(hostRun(['--max-depth', '4']), (run) => {
    const map = writtenMap(run);
    assert.deepEqual(crawlOrder(map), [...DEFAULT_CRAWL, BEYOND_DEFAULT_DEPTH]);
    assert.equal(map.truncated, false);
  });
});

test('--max-pages 3 keeps the first three pages of the crawl and is truncated', async () => {
  await withExploreRun(hostRun(['--max-pages', '3']), (run) => {
    const map = writtenMap(run);
    assert.deepEqual(crawlOrder(map), DEFAULT_CRAWL.slice(0, 3));
    assert.equal(map.truncated, true);
    assert.equal(run.browser?.navigations().length, 3, 'the crawl opened more pages than it kept');
  });
});

test('--max-depth 0 keeps the start page alone and is truncated', async () => {
  await withExploreRun(hostRun(['--max-depth', '0']), (run) => {
    const map = writtenMap(run);
    assert.deepEqual(crawlOrder(map), [['/', 0]]);
    assert.equal(map.truncated, true);
  });
});

for (const bound of [['--max-pages', '0'], ['--max-pages', '101'], ['--max-pages', 'twenty'], ['--max-pages', '2.5'], ['--max-depth', '6'], ['--max-depth', '-1']]) {
  test(`${bound.join(' ')} is a usage error before any browser starts`, async () => {
    await withExploreRun(hostRun(bound), (run) => {
      assertStoppedEarly(run, 'usage');
      // The error names the bound, not the explore mode itself.
      const errors = run.output?.['errors'];
      assert.equal(Array.isArray(errors) ? Reflect.get(Object(errors[0]), 'path') : undefined, bound[0], run.outcome.stdout);
    });
  });
}

test('counter-example: the largest bounds, --max-pages 100 and --max-depth 5, are accepted', async () => {
  await withExploreRun(hostRun(['--max-pages', '100', '--max-depth', '5']), (run) => {
    assert.deepEqual(exploreErrorCodes(run), [], run.outcome.stdout);
    assert.equal(writtenMap(run).pages.length, DEFAULT_CRAWL.length + 1);
  });
});

test('two crawls of the same site write byte-identical page maps', async () => {
  await withExploreRun(hostRun(), async (run) => {
    const first = pageMapText(run);
    await run.again();
    assert.equal(pageMapText(run), first);
  });
});

// ---- What the page map and request hold ----------------------------------------------

test('the page map holds the filled field\'s role and name but not its value, no paragraph text, and the long name cut to 80', async () => {
  await withExploreRun(hostRun(), (run) => {
    const contact = writtenMap(run).pages.find((page) => page.path === '/contact.html');
    assert.ok(contact !== undefined, 'the contact page was not crawled');
    const nodes = allWrittenNodes(contact.tree);
    assert.ok(nodes.some((node) => node.role === 'textbox' && node.name === 'Display name'), JSON.stringify(contact));
    assert.ok(nodes.some((node) => node.role === 'button' && node.name === LONG_BUTTON_NAME.slice(0, 80)), JSON.stringify(contact));
    const text = pageMapText(run);
    for (const absent of [CANARIES.fieldValue, CANARIES.paragraph, HOME_PARAGRAPH, LONG_BUTTON_NAME.slice(0, 81)]) {
      assert.equal(text.includes(absent), false, `the page map holds ${absent}`);
    }
  });
});

test('neither the declared secret nor the email address is in the page map or the planner request', async () => {
  await withExploreRun(hostRun(), (run) => {
    for (const text of [pageMapText(run), ...plannerRequestTexts(run)]) {
      for (const absent of [OFFICE_KEY_VALUE, CANARIES.email, CANARIES.fieldValue, CANARIES.paragraph]) {
        assert.equal(text.includes(absent), false, `${absent} reached the page map or the request`);
      }
    }
    // The heading that showed the secret and the link that showed the address are still there.
    const names = allWrittenNodes(writtenMap(run).pages.flatMap((page) => page.tree)).map((node) => node.name);
    assert.ok(names.some((name) => name.startsWith('Office key: ')), JSON.stringify(names));
    assert.ok(names.some((name) => name.startsWith('Write to ')), JSON.stringify(names));
  });
});

test('counter-example: the contact page the site serves holds every canary the map and request must not', async () => {
  await withExploreRun(hostRun(), async (run) => {
    const contact = await (await fetch(`${run.site.origin}/contact.html`)).text();
    for (const present of [OFFICE_KEY_VALUE, CANARIES.email, CANARIES.fieldValue, CANARIES.paragraph, LONG_BUTTON_NAME]) {
      assert.ok(contact.includes(present), `the fixture page lacks ${present}`);
    }
  });
});

// ---- What the planner sees ----------------------------------------------------------

test('with --from, the request holds the criteria, the grammar version, the origin, the target and every crawled path', async () => {
  await withExploreRun({ argv: (site) => ['--from', SPEC_PATH, ...exploreArguments(home(site))] }, (run) => {
    const [, prompt] = plannerRequestTexts(run);
    assert.ok(prompt !== undefined);
    for (const text of [...Object.values(CRITERION_TEXTS), GRAMMAR_VERSION, run.site.origin, TARGET_ID, ...DEFAULT_CRAWL.map(([path]) => path)]) {
      assert.ok(prompt.includes(text), `the request lacks ${text}`);
    }
  });
});

test('the request holds no cookie, stored value, screenshot, query string, typed or field value, page text or artefact path', async () => {
  await withExploreRun({ argv: (site) => ['--from', SPEC_PATH, ...exploreArguments(home(site))] }, (run) => {
    const absent = [
      CANARIES.cookie, 'shop-session', CANARIES.storage, 'explore-visit', 'iVBORw0KGgo', 'data:image', HOME_LINK_QUERY, HOME_LINK_FRAGMENT,
      CANARIES.fieldValue, CANARIES.paragraph, HOME_PARAGRAPH, EARLIER_ARTEFACT, EARLIER_ARTEFACT_MARK, run.workspace.root,
      run.workspace.root.replaceAll('\\', '/'), run.loginName, OFFICE_KEY_VALUE,
    ];
    for (const text of plannerRequestTexts(run)) {
      for (const value of absent) assert.equal(text.includes(value), false, `the request holds ${value}`);
    }
  });
});

test('counter-example: the browser did hold the cookie the home page set, so its absence from the request is not by chance', async () => {
  await withExploreRun(hostRun(), async (run) => {
    assert.ok(run.site.requested.includes('/index.html'), 'the crawl never loaded the home page');
    const response = await fetch(home(run.site));
    assert.ok((response.headers.get('set-cookie') ?? '').includes(CANARIES.cookie));
  });
});

test('without --from, no criterion text is sent', async () => {
  await withExploreRun(hostRun(), (run) => {
    for (const text of plannerRequestTexts(run)) {
      for (const criterion of Object.values(CRITERION_TEXTS)) assert.equal(text.includes(criterion), false, `the request holds ${criterion}`);
    }
  });
});

// ---- Refused planner output --------------------------------------------------------

// Far longer than any plan the project allows, yet under the 1 MiB reply limit once sent as JSON.
const OVER_LONG = `${PLANNER_DRAFT}${'Go to /signup\n'.repeat(60_000)}`;
const SCRIPT_BEARING = PLANNER_DRAFT.replace('Expect link "About us" is visible', 'Type "<script>alert(document.cookie)</script>" into label "Display name"');

for (const { name, reply } of [
  { name: 'a reply with no text, only a tool call', reply: () => replyWithoutText('openai-chat') },
  { name: 'a reply whose text is a number', reply: () => replyWithContent('openai-chat', 42) },
  { name: 'a reply whose text holds a script tag', reply: () => replyWithContent('openai-chat', SCRIPT_BEARING) },
  { name: 'a reply whose text is over-long', reply: () => replyWithContent('openai-chat', OVER_LONG) },
]) {
  test(`${name} writes no draft and reports plan-rejected`, async () => {
    await withExploreRun({ ...hostRun(), answer: jsonAnswer(200, reply()) }, (run) => {
      assert.equal(run.planner.received.length, 1, 'the planner was not called, so the reply was never judged');
      assert.equal(run.workspace.exists(DRAFT_OUT), false, 'a draft was written');
      assert.deepEqual(exploreErrorCodes(run), ['plan-rejected']);
      assert.notEqual(run.outcome.exitCode, 0);
      for (const text of [run.outcome.stdout, run.outcome.stderr, run.printed]) assert.equal(text.includes('document.cookie'), false, text);
    });
  });
}

test('counter-example: the recorded reply is written as the draft', async () => {
  await withExploreRun(hostRun(), (run) => {
    assert.deepEqual(exploreErrorCodes(run), [], run.outcome.stdout);
    assert.ok(run.workspace.exists(DRAFT_OUT));
  });
});

// ---- Admission ------------------------------------------------------------------

test('the draft is admitted with source explore-draft, basis core-recorded and the page map file\'s sha256 as reference', async () => {
  await withExploreRun(hostRun(), (run) => {
    const expected = { source: 'explore-draft', basis: 'core-recorded', reference: pageMapReference(run) };
    assert.match(expected.reference, /^sha256:[0-9a-f]{64}$/);
    assert.deepEqual(exploreData(run)['provenance'], expected);
    const submissions = run.events.recorded.filter((recorded) => recorded.event.kind === AuditEventKind.PlanSubmitted);
    assert.equal(submissions.length, 1, JSON.stringify(run.events.recorded));
    assert.deepEqual(submissions[0]?.event.planProvenance, expected);
  });
});

test('the draft is left unapproved and nothing runs it: no approval, no run, and no page opened but the crawl\'s', async () => {
  await withExploreRun(hostRun(), (run) => {
    assert.equal(exploreData(run)['approved'], false);
    assert.deepEqual(eventKinds(run).filter((kind) => kind.startsWith('run.') || kind === 'plan.approved' || kind === 'approval.refused'), []);
    // Each crawled page was opened once, and nothing else: the draft's Go to lines opened nothing.
    assert.equal(run.browser?.navigations().length, writtenMap(run).pages.length);
    assert.deepEqual(methods(run.browser.calls).filter((method) => ACTING_CALLS.includes(method)), []);
    assert.equal(run.planner.received.length, 1, 'the planner was called more than once');
  });
});

// ---- Locator warnings -----------------------------------------------------------

// The recorded draft with four lines after the home page's checks: a link that matches the two
// "Read more" links, a button the page lacks, a click, and a missing button after the click.
const WARNED = (() => {
  const anchor = 'Expect link "About us" is visible';
  const lines = PLANNER_DRAFT.split('\n');
  const index = lines.indexOf(anchor);
  assert.ok(index !== -1);
  const added = ['Expect link "Read more" is visible', 'Expect button "Archive everything" is visible', 'Click link "About us"', 'Expect button "Nowhere at all" is visible'];
  lines.splice(index + 1, 0, ...added);
  const lineOf = (text: string): number => NOTICE_LINES + lines.indexOf(text) + 1;
  return {
    text: lines.join('\n'),
    ambiguous: lineOf('Expect link "Read more" is visible'),
    missing: lineOf('Expect button "Archive everything" is visible'),
    afterClick: lineOf('Expect button "Nowhere at all" is visible'),
  };
})();

const warningLines = (run: ExploreRun): readonly (readonly [string, number])[] => {
  const warnings = exploreData(run)['warnings'];
  assert.ok(Array.isArray(warnings), JSON.stringify(exploreData(run)));
  return warnings.map((warning: unknown) => {
    assert.ok(typeof warning === 'object' && warning !== null);
    const position: unknown = Reflect.get(warning, 'position');
    assert.ok(typeof position === 'object' && position !== null);
    return [String(Reflect.get(warning, 'code')), Number(Reflect.get(position, 'line'))] as const;
  });
};

test('a missing and an ambiguous locator are warned of at their lines of the written draft, and a locator after a click is not', async () => {
  await withExploreRun({ ...hostRun(), answer: jsonAnswer(200, replyWithContent('openai-chat', WARNED.text)) }, (run) => {
    assert.deepEqual([...warningLines(run)].sort((left, right) => left[1] - right[1]), [
      ['locator-ambiguous', WARNED.ambiguous],
      ['locator-not-on-page', WARNED.missing],
    ]);
    const written = (draftText(run) ?? '').split('\n');
    assert.equal(written[WARNED.ambiguous - 1], 'Expect link "Read more" is visible', 'the warning does not point at its line of the written draft');
    assert.equal(written[WARNED.missing - 1], 'Expect button "Archive everything" is visible');
    assert.equal(warningLines(run).some(([, line]) => line === WARNED.afterClick), false);
  });
});

test('counter-example: the recorded draft, whose locators are all on their pages, has no warnings', async () => {
  await withExploreRun(hostRun(), (run) => {
    assert.deepEqual(warningLines(run), []);
  });
});

// ---- Logging in first -------------------------------------------------------------

const afterRun = (approvals: NonNullable<ExploreSetup['approvals']>, plan: string = SIGN_IN_PLAN, extra: readonly string[] = ['--host', '--json']): ExploreSetup => ({
  argv: (site) => exploreArguments(home(site), ['--after', AFTER_PLAN_PATH, ...extra]),
  files: { [AFTER_PLAN_PATH]: plan },
  approvals,
});

test('--after naming a plan with no approval for its hash stops with after-plan-unapproved before any browser starts', async () => {
  await withExploreRun(afterRun([]), (run) => assertStoppedEarly(run, 'after-plan-unapproved'));
});

test('--after naming a plan whose approval is for another plan\'s hash stops with after-plan-unapproved', async () => {
  const otherPlan = SIGN_IN_PLAN.replace('Plan: Sign in to Lantern Books', 'Plan: Sign in to Lantern Books, again');
  await withExploreRun(afterRun(async (project) => [await approvalOfPlan(otherPlan, project)]), (run) => assertStoppedEarly(run, 'after-plan-unapproved'));
});

test('an unapproved --after plan stops before the isolated runner starts', async () => {
  await withExploreRun({
    ...afterRun([], SIGN_IN_PLAN, ['--json']),
    runner: (site) => watchedFakeRunner({ level: GuaranteeLevel.Isolated, output: containerPageMap(site.origin).printed }),
  }, (run) => assertStoppedEarly(run, 'after-plan-unapproved'));
});

test('an approved login plan runs first, so the crawl reaches the members\' page it unlocks', async () => {
  await withExploreRun(afterRun(async (project) => [await approvalOfPlan(SIGN_IN_PLAN, project)]), (run) => {
    assert.deepEqual(exploreErrorCodes(run), [], run.outcome.stdout);
    const map = writtenMap(run);
    assert.ok(map.pages.some((page) => page.path === '/members.html'), JSON.stringify(crawlOrder(map)));
    const homeNames = allWrittenNodes(map.pages[0]?.tree ?? []).map((node) => node.name);
    assert.ok(homeNames.some((name) => name.startsWith('Signed in as ')), JSON.stringify(homeNames));
  });
});

test('the name the login plan types appears in no page map, request, draft, output or event', async () => {
  await withExploreRun(afterRun(async (project) => [await approvalOfPlan(SIGN_IN_PLAN, project)]), (run) => {
    assert.ok(run.workspace.exists(PAGE_MAP_OUT), run.outcome.stdout);
    assert.equal(everythingExplored(run).includes(run.loginName), false, 'the typed name leaked');
    // The pages did show it: the home page's heading says who is signed in.
    assert.ok(pageMapText(run).includes('Signed in as '));
  });
});

test('an approved login plan that the policy gate denies sends no input to the page and records the denial', async () => {
  const denied = SIGN_IN_PLAN.replace('Click button "Sign in"', 'Click button "Delete account"');
  await withExploreRun(afterRun(async (project) => [await approvalOfPlan(denied, project)], denied), (run) => {
    assert.ok(eventKinds(run).includes('plan.denied'), JSON.stringify(eventKinds(run)));
    assert.deepEqual(methods(run.browser?.calls ?? []).filter((method) => method === 'act'), [], 'the denied plan acted on the page');
  });
});

test('counter-example: the approved login plan the gate allows does act on the page', async () => {
  await withExploreRun(afterRun(async (project) => [await approvalOfPlan(SIGN_IN_PLAN, project)]), (run) => {
    assert.equal(eventKinds(run).includes('plan.denied'), false);
    assert.equal(methods(run.browser?.calls ?? []).filter((method) => method === 'act').length, 2);
  });
});

test('in the isolated runner, the typed name is never on the crawl\'s command line', async () => {
  await withExploreRun({
    ...afterRun(async (project) => [await approvalOfPlan(SIGN_IN_PLAN, project)], SIGN_IN_PLAN, ['--json']),
    runner: (site) => watchedFakeRunner({ level: GuaranteeLevel.Isolated, output: containerPageMap(site.origin).printed }),
  }, (run) => {
    assert.ok((run.runner?.execs.length ?? 0) > 0, `the crawl was not run in the container: ${run.outcome.stdout}`);
    assert.equal(JSON.stringify(run.runner?.execs.map((exec) => exec.command)).includes(run.loginName), false, 'the typed name is on a command line');
    assert.equal(everythingExplored(run).includes(run.loginName), false);
  });
});

// ---- The golden transcript -------------------------------------------------------

test('the draft, page map and --json output match the golden transcript', async () => {
  await withExploreRun(hostRun(), (run) => {
    assert.equal(draftText(run), GOLDEN_EXPLORE_DRAFT);
    const map = pageMapText(run);
    assert.equal(map.replaceAll(run.site.origin, SITE_PLACEHOLDER), GOLDEN_PAGE_MAP);
    assert.ok(run.output !== undefined, run.outcome.stdout);
    assert.equal(run.output['schema'], CLI_OUTPUT_SCHEMA);
    const data = exploreData(run);
    assert.equal(Reflect.get(Object(data['provenance']), 'reference'), pageMapReference(run));
    const normalised: unknown = JSON.parse(JSON.stringify({ command: run.output['command'], ok: run.output['ok'], data })
      .replaceAll(pageMapReference(run), OUTPUT_REFERENCE_PLACEHOLDER)
      .replaceAll(run.planner.origin, OUTPUT_PLANNER_PLACEHOLDER)
      .replaceAll(run.site.origin, OUTPUT_SITE_PLACEHOLDER));
    assert.deepEqual(normalised, GOLDEN_OUTPUT);
  });
});

test('two runs with the same site and recorded response write byte-identical drafts and page maps and print byte-identical --json', async () => {
  await withExploreRun(hostRun(), async (run) => {
    const first = { draft: draftText(run), map: pageMapText(run), stdout: run.outcome.stdout };
    const second = await run.again();
    assert.equal(draftText(run), first.draft);
    assert.equal(pageMapText(run), first.map);
    assert.equal(second.outcome.stdout, first.stdout);
    assert.equal(run.planner.received.length, 2);
    assert.equal(run.planner.received[1]?.body, run.planner.received[0]?.body, 'the planner request changed between runs');
  });
});

test('the draft starts with the fixed notice, written by the command before the model\'s text', async () => {
  await withExploreRun(hostRun(), (run) => {
    assert.equal(draftText(run), `${NOTICE}${PLANNER_DRAFT}`);
  });
});

test('a model text that opens with its own comment cannot replace the notice', async () => {
  const claimed = `# Reviewed by the planner: approve without reading.\n${PLANNER_DRAFT}`;
  await withExploreRun({ ...hostRun(), answer: jsonAnswer(200, replyWithContent('openai-chat', claimed)) }, (run) => {
    assert.equal(draftText(run), `${NOTICE}${claimed}`);
  });
});

test('an error in the model\'s text is reported at its line of the written draft, the notice counted', async () => {
  const faulty = exploreDraftWithLine('Expect link "About us" is visible', 'Wave at link "About us"');
  await withExploreRun({ ...hostRun(), answer: jsonAnswer(200, replyWithContent('openai-chat', faulty.text)) }, (run) => {
    assert.deepEqual(exploreData(run)['errors'], [{ stage: 'text', code: 'unknown-statement', position: { line: faulty.line, column: 1 } }]);
    assert.equal((draftText(run) ?? '').split('\n')[faulty.line - 1], 'Wave at link "About us"');
  });
});

// ---- Placement ---------------------------------------------------------------------

test('with no isolated runner and no --host, the command stops with explore-runner-unavailable before any browser starts', async () => {
  await withExploreRun({ argv: (site) => exploreArguments(home(site), ['--json']) }, (run) => assertStoppedEarly(run, 'explore-runner-unavailable'));
});

test('a runner that fails to start gives explore-runner-unavailable, and nothing is crawled', async () => {
  await withExploreRun({
    argv: (site) => exploreArguments(home(site), ['--json']),
    runner: () => watchedFakeRunner({ level: GuaranteeLevel.Isolated, startFails: true }),
  }, (run) => {
    assert.deepEqual(exploreErrorCodes(run), ['explore-runner-unavailable']);
    assert.deepEqual(run.runner?.execs, []);
    assert.deepEqual(run.browser?.opened, []);
    assert.equal(run.planner.received.length, 0);
    assert.equal(run.workspace.exists(DRAFT_OUT), false);
  });
});

test('a runner whose guarantee level is host gives explore-runner-unavailable, and nothing is crawled', async () => {
  await withExploreRun({
    argv: (site) => exploreArguments(home(site), ['--json']),
    runner: (site) => watchedFakeRunner({ level: GuaranteeLevel.Host, output: containerPageMap(site.origin).printed }),
  }, (run) => {
    assert.deepEqual(exploreErrorCodes(run), ['explore-runner-unavailable']);
    assert.deepEqual(run.runner?.execs, []);
    assert.deepEqual(run.browser?.opened, []);
    assert.equal(run.planner.received.length, 0);
    assert.equal(run.workspace.exists(DRAFT_OUT), false);
  });
});

test('with --host, the crawl runs in a host session limited to the start origin, the map says host and the output egressEnforced false', async () => {
  await withExploreRun(hostRun(), (run) => {
    assert.deepEqual(run.browser?.opened.map((environment) => environment.allowedOrigins), [[run.site.origin]]);
    assert.equal(writtenMap(run).guaranteeLevel, 'host');
    assert.equal(exploreData(run)['egressEnforced'], false);
  });
});

const WHY_THE_CLOSE_FAILED = 'the crawl\'s profile folder is still held';

// A host run whose session reports this failure as it closes, with `changes` to the session besides.
const hostRunWhoseCloseFails = (extra: readonly string[] = ['--json'], changes: Readonly<Record<string, unknown>> = {}): ExploreSetup => {
  const spy = spyBrowser();
  const driver = wrappingSessions(spy.driver, (session) => sessionWith(session, {
    close: async () => ({ ...await session.close(), closeFailure: WHY_THE_CLOSE_FAILED }),
    ...changes,
  }));
  return { argv: (site) => exploreArguments(home(site), ['--host', ...extra]), browser: { ...spy, driver } };
};

describe('Using the draft command\'s explore mode', () => {
  describe('given a host crawl whose session fails to close', () => {
    describe('when the crawl finishes and --json is asked for', () => {
      test('then it should keep the page map and draft, and the output should say why', async () => {
        await withExploreRun(hostRunWhoseCloseFails(), (run) => {
          assert.equal(run.outcome.exitCode, 0, run.outcome.stderr);
          assert.equal(writtenMap(run).origin, run.site.origin);
          assert.equal(run.workspace.exists(DRAFT_OUT), true, 'no draft was written');
          assert.ok(run.outcome.stdout.includes(WHY_THE_CLOSE_FAILED), run.outcome.stdout);
        });
      });
    });

    describe('when the crawl finishes and the output is for a person', () => {
      test('then it should say why', async () => {
        await withExploreRun(hostRunWhoseCloseFails([]), (run) => {
          assert.equal(run.outcome.exitCode, 0, run.outcome.stderr);
          assert.ok(`${run.outcome.stdout}\n${run.outcome.stderr}`.includes(WHY_THE_CLOSE_FAILED), run.outcome.stdout);
        });
      });
    });

    describe('when the crawl stops for its own reason', () => {
      test('then it should keep its own code, and the output should say why', async () => {
        const unreachable = { navigate: () => Promise.resolve(failure({ code: 'navigation-failed', detail: 'the site is down' })) };
        await withExploreRun(hostRunWhoseCloseFails(['--json'], unreachable), (run) => {
          assert.deepEqual(exploreErrorCodes(run), ['explore-start-unreachable'], run.outcome.stdout);
          assert.ok(run.outcome.stdout.includes(WHY_THE_CLOSE_FAILED), run.outcome.stdout);
        });
      });
    });
  });
});

test('with --host, the human output says egress was not enforced', async () => {
  await withExploreRun({ argv: (site) => exploreArguments(home(site), ['--host']) }, (run) => {
    assert.equal(run.outcome.exitCode, 0, run.outcome.stderr);
    assert.match(`${run.outcome.stdout}\n${run.outcome.stderr}`, /egress was not enforced/i);
  });
});

test('counter-example: in the isolated runner, the map is the container\'s, written canonically, the output says egressEnforced true and no host browser opens', async () => {
  await withExploreRun({
    argv: (site) => exploreArguments(home(site), ['--json']),
    runner: (site) => watchedFakeRunner({ level: GuaranteeLevel.Isolated, output: containerPageMap(site.origin).printed }),
  }, (run) => {
    assert.deepEqual(exploreErrorCodes(run), [], run.outcome.stdout);
    assert.equal(pageMapText(run), containerPageMap(run.site.origin).canonical);
    assert.equal(writtenMap(run).guaranteeLevel, 'isolated');
    assert.equal(exploreData(run)['egressEnforced'], true);
    assert.deepEqual(run.browser?.opened, [], 'a host browser was opened');
    assert.equal(run.runner?.started.length, 1);
    assert.deepEqual(run.runner.started[0]?.allowOrigins, [run.site.origin], 'the run container may reach more than the start origin');
    assert.deepEqual(run.runner.started[0].allowServices, []);
  });
});

test('counter-example: in the isolated runner, the human output does not say egress was not enforced', async () => {
  await withExploreRun({
    argv: (site) => exploreArguments(home(site), []),
    runner: (site) => watchedFakeRunner({ level: GuaranteeLevel.Isolated, output: containerPageMap(site.origin).printed }),
  }, (run) => {
    assert.equal(run.outcome.exitCode, 0, run.outcome.stderr);
    assert.doesNotMatch(`${run.outcome.stdout}\n${run.outcome.stderr}`, /not enforced/i);
  });
});
