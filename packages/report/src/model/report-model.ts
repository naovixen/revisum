// The report model. A ValidReport comes only from parseReportInput (report-parser.ts), and
// generate() accepts nothing else, so unvalidated data cannot reach the renderer.
// See docs/specs/SPEC-12-visual-report-and-pr-comment.md.
import type { Box, Brand } from '@revisum/contracts';
import { PRODUCT } from '@revisum/contracts';

export const SEVERITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Severity = (typeof SEVERITIES)[number];
export type Verdict = 'passed' | 'failed' | 'needs-review';
export type ReportKind = 'a11y' | 'functional' | 'api';
export const MAXIMUM_CAPTION_WORDS = 15;

export const REPORT_INPUT_SCHEMA = `${PRODUCT.schemaNamespace}.report-input/v1` as const;
export const HISTORY_SCHEMA = `${PRODUCT.schemaNamespace}.history/v1` as const;
export const REPORT_MANIFEST_SCHEMA = `${PRODUCT.schemaNamespace}.report-manifest/v1` as const;

// A box in the pixels of the original PNG.
export type PixelBox = Box;

export interface ImageMeta { readonly id: string; readonly sha256: string; readonly width: number; readonly height: number; readonly alt: string }

export interface Exchange {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly status: number | null;
  readonly requestLines: readonly string[];
  readonly responseLines: readonly string[];
}

export type Criterion =
  | { readonly kind: 'wcag'; readonly successCriterion: string; readonly title: string; readonly level: 'A' | 'AA' | 'AAA' }
  | { readonly kind: 'assertion'; readonly text: string };

export interface Finding {
  readonly id: string;
  readonly status: 'failed' | 'needs-review';
  readonly severity: Severity | null;
  readonly title: string;
  // 15 words or fewer.
  readonly caption: string;
  readonly rule: string;
  readonly criterion: Criterion;
  readonly criterionIds: readonly string[];
  readonly stepIds: readonly string[];
  readonly steps: readonly string[];
  readonly image: { readonly imageId: string; readonly box: PixelBox | null } | null;
  readonly exchanges: readonly Exchange[];
  readonly log: readonly string[];
  readonly reason: string | null;
  readonly action: string | null;
}

export type EvidenceReference = { readonly kind: 'finding' | 'image' | 'exchange' | 'step'; readonly id: string; readonly label: string };
export interface AcceptanceCriterion {
  readonly id: string;
  readonly text: string;
  readonly status: Verdict;
  readonly stepIds: readonly string[];
  readonly evidence: readonly EvidenceReference[];
}
export interface PlanStep { readonly id: string; readonly text: string; readonly result: string }
export interface RunInfo {
  readonly runId: string;
  // The only time in any output, copied from the run manifest.
  readonly recordedAt: string;
  readonly target: string;
  readonly tool: string;
  readonly manifestHash: string | null;
  readonly inputs: readonly { readonly name: string; readonly sha256: string }[];
}
export interface ReportInput {
  readonly schema: typeof REPORT_INPUT_SCHEMA;
  readonly reportId: string;
  readonly kind: ReportKind;
  readonly title: string;
  readonly subject: string;
  readonly note: string | null;
  readonly run: RunInfo;
  readonly acceptance: readonly AcceptanceCriterion[];
  readonly steps: readonly PlanStep[];
  readonly findings: readonly Finding[];
  readonly images: readonly ImageMeta[];
}

export interface HistoryPeriod {
  readonly id: string;
  readonly changes: number;
  readonly changesVerifiedWithoutReview: number;
  readonly criteriaInScope: number;
  readonly criteriaTraced: number;
  readonly runs: number;
  readonly flakyRuns: number;
  readonly escaped: Readonly<Record<Severity, number>>;
}
export interface History {
  readonly schema: typeof HISTORY_SCHEMA;
  readonly synthetic: boolean;
  readonly label: string;
  readonly periods: readonly HistoryPeriod[];
}

export type ReportError = { readonly path: string; readonly code: string };
export type Parsed<Value> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: readonly ReportError[] };

// A ReportInput that went through parseReportInput. generate() takes only this.
export type ValidReport = Brand<ReportInput, 'ValidReport'>;
