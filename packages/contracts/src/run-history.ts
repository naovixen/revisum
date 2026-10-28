// Run history and the ladder's thresholds, read by the review recorder, the metrics panel and the
// maturity ladder. See docs/specs/SPEC-27-shared-types-and-events.md.
import type { ActorType } from './audit-events.ts';

// One finished run, as later runs and metrics see it.
export type RunRecord = {
  readonly runId: string;
  readonly changeClassId: string;
  readonly commit: string | null;
  // ISO 8601 time the run finished.
  readonly at: string;
  readonly criteriaInScope: number;
  readonly criteriaTraced: number;
  readonly passedFirstTime: boolean;
  // True when the same inputs gave one pass and one failure.
  readonly flakyPair: boolean;
  readonly decisions: readonly { readonly itemId: string; readonly actorType: ActorType }[];
};

export type ThresholdMetric =
  | 'agentAuthoredShare' | 'specLinkedShare' | 'tracedCriteriaShare' | 'mutantsCaughtShare'
  | 'verifiedWithoutReviewShare' | 'unreviewedMergeShare' | 'flakyRunRate';

// The level each metric must reach, over how many consecutive windows, before the ladder moves.
// A window with fewer changes than minimumChangesPerWindow does not count.
export type Thresholds = Readonly<Record<ThresholdMetric, number>> & {
  readonly windows: number;
  readonly minimumChangesPerWindow: number;
};
