// The accessibility engine's re-score against the W3C ACT test cases: every pinned case of every
// implemented ACT rule is scanned, and the engine's outcome must match the expected outcome
// (passed, failed or inapplicable) on at least 80% of them.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ALL_RULES, launchBrowser, scan, type Browser, type Outcome, type PageDriver } from '@revisum/auditor-act';
import { BROWSERS } from '../support/browsers.ts';
import { ACT_CASE_PREFIX, ACT_TEST_CASES, startAccessibilityServer, type AccessibilityServer } from '../support/accessibility-server.ts';

type ActTestCase = {
  readonly ruleId: string; readonly expected: Outcome; readonly testcaseId: string;
  readonly testcaseTitle: string; readonly relativePath: string;
};
type CaseScore = { readonly ruleId: string; readonly testcaseId: string; readonly expected: Outcome; readonly own: Outcome; readonly error?: string };

const OUTCOMES: readonly Outcome[] = ['passed', 'failed', 'inapplicable', 'cantTell'];

function implementedCases(): ActTestCase[] {
  const all = JSON.parse(readFileSync(join(ACT_TEST_CASES, 'testcases.json'), 'utf8')) as { testcases: ActTestCase[] };
  const implemented = new Set(ALL_RULES.filter((rule) => rule.meta.kind === 'act-rule').map((rule) => rule.meta.id));
  return all.testcases.filter((testCase) => implemented.has(testCase.ruleId));
}

// The engine's outcome for one case is the outcome of that case's rule on the page.
async function scoreCases(browser: Browser, origin: string): Promise<CaseScore[]> {
  const scores: CaseScore[] = [];
  let page: PageDriver = await browser.newPage();
  for (const testCase of implementedCases()) {
    const url = `${origin}${ACT_CASE_PREFIX}${testCase.relativePath}`;
    try {
      const scanned = await scan(page, url, { page: `act:${testCase.ruleId}/${testCase.testcaseId}`, rules: [testCase.ruleId] });
      const own = scanned.runs.find((ruleRun) => ruleRun.ruleId === testCase.ruleId)?.outcome ?? 'inapplicable';
      scores.push({ ruleId: testCase.ruleId, testcaseId: testCase.testcaseId, expected: testCase.expected, own });
    } catch (error) {
      scores.push({ ruleId: testCase.ruleId, testcaseId: testCase.testcaseId, expected: testCase.expected, own: 'cantTell', error: (error as Error).message });
      await page.close().catch(() => undefined);
      page = await browser.newPage();
    }
  }
  await page.close();
  return scores;
}

let server: AccessibilityServer;
let browser: Browser;
before(async () => { server = await startAccessibilityServer(); browser = await launchBrowser(BROWSERS.chrome); }, { timeout: 60_000 });
after(async () => { await browser?.close(); await server?.close(); });

test('the own engine agrees with at least 80% of the W3C ACT test cases of its implemented rules', { criterion: 'AC-SPEC-00-01', timeout: 600_000 }, async () => {
  const scores = await scoreCases(browser, server.origin);
  const pinned = implementedCases().length;
  assert.equal(scores.length, pinned, 'every pinned case of every implemented rule is scored');
  assert.ok(scores.every((score) => OUTCOMES.includes(score.own)), 'every case has an outcome');
  const agree = scores.filter((score) => score.own === score.expected).length;
  const percent = Math.round((1000 * agree) / scores.length) / 10;
  const misses = scores.filter((score) => score.own !== score.expected)
    .map((score) => `${score.ruleId}/${score.testcaseId}: expected ${score.expected}, own ${score.own}${score.error ? ` (${score.error})` : ''}`);
  assert.ok(percent >= 80, `strict agreement ${percent}% (${agree} of ${scores.length}); misses:\n${misses.join('\n')}`);
});
