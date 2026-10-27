// Derives everything the renderers show from the model, once, in one place. Pure.
import { usableBox, type Callout } from './annotated-screenshot.ts';
import { SEVERITIES, type AcceptanceCriterion, type Finding, type ReportInput, type Severity, type Verdict } from './model/report-model.ts';

export interface NumberedFinding { readonly number: number; readonly finding: Finding }
export interface ImageFigure {
  readonly imageId: string;
  readonly callouts: readonly Callout[];
  // Findings on this image without a usable box.
  readonly pageLevel: readonly NumberedFinding[];
}
export interface ReportView {
  readonly numbered: readonly NumberedFinding[];
  readonly counts: { readonly passed: number; readonly failed: number; readonly needsReview: number; readonly total: number };
  readonly overall: Verdict;
  readonly highest: Severity | null;
  readonly figures: readonly ImageFigure[];
  readonly top: ImageFigure | null;
  readonly review: readonly NumberedFinding[];
}

const severityRank = (severity: Severity | null): number => (severity === null ? 9 : SEVERITIES.indexOf(severity));

// Failed first, then by severity (unrated last), then in the order given. Numbers follow this order.
export function orderFindings(findings: readonly Finding[]): readonly NumberedFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => (left.finding.status === right.finding.status ? 0 : left.finding.status === 'failed' ? -1 : 1)
      || severityRank(left.finding.severity) - severityRank(right.finding.severity) || left.index - right.index)
    .map((entry, position) => ({ number: position + 1, finding: entry.finding }));
}

export function countVerdicts(acceptance: readonly AcceptanceCriterion[]): ReportView['counts'] {
  const count = (verdict: Verdict): number => acceptance.filter((criterion) => criterion.status === verdict).length;
  return { passed: count('passed'), failed: count('failed'), needsReview: count('needs-review'), total: acceptance.length };
}

export function deriveView(report: ReportInput): ReportView {
  const numbered = orderFindings(report.findings);
  const counts = countVerdicts(report.acceptance);
  const overall: Verdict = counts.failed > 0 ? 'failed' : counts.needsReview > 0 ? 'needs-review' : 'passed';
  const failedSeverities = numbered.filter((entry) => entry.finding.status === 'failed').map((entry) => entry.finding.severity);
  const highest = SEVERITIES.find((severity) => failedSeverities.includes(severity)) ?? null;
  const figures: ImageFigure[] = report.images.map((image) => {
    const onImage = numbered.filter((entry) => entry.finding.image?.imageId === image.id);
    const callouts: Callout[] = [];
    const pageLevel: NumberedFinding[] = [];
    for (const entry of onImage) {
      const box = usableBox(entry.finding.image?.box ?? null, image.width, image.height);
      if (box === null) pageLevel.push(entry);
      else callouts.push({ number: entry.number, finding: entry.finding, box });
    }
    return { imageId: image.id, callouts, pageLevel };
  });
  // The top-problem screenshot: the best failed severity among its callouts, then the most callouts, then input order.
  const bestRank = (figure: ImageFigure): number =>
    Math.min(9, ...figure.callouts.filter((callout) => callout.finding.status === 'failed').map((callout) => severityRank(callout.finding.severity)));
  const candidates = figures.map((figure, index) => ({ figure, index }))
    .filter((entry) => entry.figure.callouts.some((callout) => callout.finding.status === 'failed'));
  candidates.sort((left, right) => bestRank(left.figure) - bestRank(right.figure)
    || right.figure.callouts.length - left.figure.callouts.length || left.index - right.index);
  return {
    numbered, counts, overall, highest, figures, top: candidates[0]?.figure ?? null,
    review: numbered.filter((entry) => entry.finding.status === 'needs-review'),
  };
}
