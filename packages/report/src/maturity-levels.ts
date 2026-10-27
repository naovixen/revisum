// The provisional maturity levels 0 to 5 and the metrics the metrics panel shows.
// See docs/specs/SPEC-15-metrics-panel.md.
import type { History, HistoryPeriod, Severity } from './model/report-model.ts';

export type Level = 0 | 1 | 2 | 3 | 4 | 5;
export interface PeriodMetrics {
  readonly period: string;
  readonly escaped: Readonly<Record<Severity, number>>;
  readonly verifiedWithoutReviewShare: number;
  readonly flakyRunRate: number;
  readonly tracedCriteriaShare: number;
}
export const LEVEL_NAMES: Readonly<Record<Level, string>> = {
  0: 'Manual', 1: 'Assisted', 2: 'Checked', 3: 'Spec-linked', 4: 'Spec-verified', 5: 'Specs in, software out',
};
export const LEVEL_RULES: Readonly<Record<Level, string>> = {
  0: 'Level 1 does not hold',
  1: 'traced share of acceptance criteria at least 20%',
  2: 'traced at least 50% and verified without manual review at least 30%',
  3: 'traced at least 80%, verified at least 60%, flaky runs at most 5%',
  4: 'traced at least 95%, verified at least 80%, flaky at most 2%, no escaped P1 or P2 in the last 4 periods',
  5: 'level 4 thresholds in each of the last 8 periods, verified at least 95%, no escaped P1, P2 or P3 in those 8',
};

export const metricsFor = (period: HistoryPeriod): PeriodMetrics => ({
  period: period.id,
  escaped: period.escaped,
  verifiedWithoutReviewShare: period.changesVerifiedWithoutReview / period.changes,
  flakyRunRate: period.flakyRuns / period.runs,
  tracedCriteriaShare: period.criteriaTraced / period.criteriaInScope,
});

// Compare with a small tolerance, so that exactly 20%, 50% and so on meet the threshold.
const atLeast = (value: number, threshold: number): boolean => value >= threshold - 1e-9;
const atMost = (value: number, threshold: number): boolean => value <= threshold + 1e-9;

function holds(level: 1 | 2 | 3 | 4, metrics: PeriodMetrics): boolean {
  switch (level) {
    case 1: return atLeast(metrics.tracedCriteriaShare, 0.2);
    case 2: return atLeast(metrics.tracedCriteriaShare, 0.5) && atLeast(metrics.verifiedWithoutReviewShare, 0.3);
    case 3: return atLeast(metrics.tracedCriteriaShare, 0.8) && atLeast(metrics.verifiedWithoutReviewShare, 0.6) && atMost(metrics.flakyRunRate, 0.05);
    case 4: return atLeast(metrics.tracedCriteriaShare, 0.95) && atLeast(metrics.verifiedWithoutReviewShare, 0.8) && atMost(metrics.flakyRunRate, 0.02);
  }
}

// The level at period `index`: the highest level whose rules, and every lower level's, hold there.
export function levelAt(history: History, index: number): Level {
  const periods = history.periods;
  const period = periods[index];
  if (period === undefined) return 0;
  const metrics = metricsFor(period);
  const lastPeriods = (count: number): readonly HistoryPeriod[] => periods.slice(Math.max(0, index - count + 1), index + 1);
  if (!holds(1, metrics)) return 0;
  if (!holds(2, metrics)) return 1;
  if (!holds(3, metrics)) return 2;
  const noEscapes = (window: readonly HistoryPeriod[], severities: readonly Severity[]): boolean =>
    window.every((entry) => severities.every((severity) => entry.escaped[severity] === 0));
  if (!holds(4, metrics) || !noEscapes(lastPeriods(4), ['P1', 'P2'])) return 3;
  const lastEight = lastPeriods(8);
  const levelFive = lastEight.length === 8
    && lastEight.every((entry) => { const entryMetrics = metricsFor(entry); return holds(4, entryMetrics) && atLeast(entryMetrics.verifiedWithoutReviewShare, 0.95); })
    && noEscapes(lastEight, ['P1', 'P2', 'P3']);
  return levelFive ? 5 : 4;
}

export const levelSeries = (history: History): readonly Level[] => history.periods.map((_, index) => levelAt(history, index));
