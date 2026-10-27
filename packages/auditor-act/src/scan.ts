// A scan: load a page, snapshot it, run the static rules, walk the keyboard, run the interactive
// rules and turn every failed or undecided target into a finding.
import type {
  Finding, PageDriver, PageSnapshot, Rule, RuleRun, ScanResult, TabWalk, TargetResult,
} from './accessibility-types.ts';
import { isStaticRule, pageOutcome } from './accessibility-types.ts';
import { INTERACTIVE_RULES } from './rules/interactive-rules.ts';
import { STATIC_RULES, ariaHiddenFocusRule, textContrastRule } from './rules/static-rules.ts';
import { boxOf, selectorFor } from './snapshot-queries.ts';
import { tabWalk } from './tab-walk.ts';

export const ALL_RULES: Rule[] = [...STATIC_RULES, textContrastRule, ariaHiddenFocusRule, ...INTERACTIVE_RULES];

export interface ScanOptions { rules?: readonly string[]; page: string }

const roundToHundredths = (value: number): number => Math.round(value * 100) / 100;

function toFindings(page: string, snapshot: PageSnapshot, rule: Rule, targets: TargetResult[], walk: TabWalk | null): Finding[] {
  const findings: Finding[] = [];
  for (const target of targets) {
    if (target.outcome === 'passed') continue;
    const node = snapshot.nodes[target.node];
    if (!node) continue;
    const box = walk?.boxes.get(target.node) ?? boxOf(snapshot, node);
    findings.push({
      page, ruleId: rule.meta.id, kind: rule.meta.kind, wcag: [...rule.meta.successCriteria], severity: rule.meta.severity,
      outcome: target.outcome, selector: selectorFor(snapshot, node),
      box: { x: roundToHundredths(box.x), y: roundToHundredths(box.y), width: roundToHundredths(box.width), height: roundToHundredths(box.height) },
      message: target.message,
    });
  }
  return findings;
}

const EMPTY_WALK = (): TabWalk => ({
  sequence: [], visits: [], endedAtDocument: true, steps: 0, boxes: new Map(), viewportBoxes: new Map(), focusVisible: new Map(), obscured: new Map(),
});

export async function scan(driver: PageDriver, url: string, options: ScanOptions): Promise<ScanResult & { walk: TabWalk | null }> {
  await driver.goto(url);
  const snapshot = await driver.snapshot();
  const rules = options.rules ? ALL_RULES.filter((rule) => options.rules?.includes(rule.meta.id)) : ALL_RULES;
  const runs: RuleRun[] = [];
  const findings: Finding[] = [];
  for (const rule of rules.filter(isStaticRule)) {
    const targets = rule.evaluate(snapshot);
    runs.push({ ruleId: rule.meta.id, outcome: pageOutcome(targets), targets });
    findings.push(...toFindings(options.page, snapshot, rule, targets, null));
  }
  const interactive = rules.filter((rule) => !isStaticRule(rule));
  let walk: TabWalk | null = null;
  if (interactive.length) {
    const ids = interactive.map((rule) => rule.meta.id);
    const needsWalk = interactive.some((rule) => !isStaticRule(rule) && rule.needsWalk);
    walk = needsWalk
      ? await tabWalk(driver, snapshot, { focusVisibility: ids.includes('oj04fd'), occlusion: ids.includes('keyboard-focus-obscured') })
      : EMPTY_WALK();
    for (const rule of interactive) {
      if (isStaticRule(rule)) continue;
      const targets = await rule.run(driver, snapshot, walk);
      runs.push({ ruleId: rule.meta.id, outcome: pageOutcome(targets), targets });
      findings.push(...toFindings(options.page, snapshot, rule, targets, walk));
    }
  }
  return { page: options.page, runs, findings, walk };
}
