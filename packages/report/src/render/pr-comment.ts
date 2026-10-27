// The pull-request comment, and the text-only verdict card used when a run has no screenshot.
import { SEVERITY_STYLE } from '../annotated-screenshot.ts';
import type { ReportInput, Verdict } from '../model/report-model.ts';
import type { ReportView } from '../report-view.ts';
import { escapeHtml, markdownEscape } from '../text-safety.ts';
import { REPORT_GENERATOR } from './html-report.ts';

const VERDICT_WORD: Readonly<Record<Verdict, string>> = { passed: 'PASSED', failed: 'FAILED', 'needs-review': 'NEEDS REVIEW' };
const VERDICT_COLOUR: Readonly<Record<Verdict, string>> = { passed: '#0b5d1e', failed: '#a50e0e', 'needs-review': '#a85200' };
export const MAXIMUM_PR_COMMENT_CHARACTERS = 1800;

export function prComment(report: ReportInput, view: ReportView, imageFile: string, imageAlt: string, reportFile: string): string {
  const top = view.numbered.slice(0, 5);
  const rows = top.map((entry) =>
    `| ${entry.number} | ${entry.finding.severity ?? 'unrated'}${entry.finding.status === 'needs-review' ? ' (review)' : ''} | ${markdownEscape(entry.finding.caption)} |`);
  const lines = [
    `### ${markdownEscape(report.title)}`,
    '',
    `**${VERDICT_WORD[view.overall]}**: ${view.counts.failed} failed, ${view.counts.needsReview} need review, ${view.counts.passed} passed. Highest severity of failures: ${view.highest ?? 'none'}.`,
    '',
    `![${markdownEscape(imageAlt)}](${imageFile})`,
    '',
    ...(rows.length > 0 ? ['| # | Severity | Finding |', '|---|---|---|', ...rows, ''] : ['No findings.', '']),
    `[Open the full report](${reportFile}) | [Review queue, ${view.review.length} item${view.review.length === 1 ? '' : 's'}](${reportFile}#review) | [Traceability](${reportFile}#trace)`,
    '',
    `Run ${markdownEscape(report.run.runId)} on ${markdownEscape(report.run.target)}, recorded ${markdownEscape(report.run.recordedAt)}. ${markdownEscape(REPORT_GENERATOR)}.`,
    '',
  ];
  return lines.join('\n');
}

// A 960 by 300 card with the verdict, the counts and the top findings. Text only, no screenshot.
export function summaryCardSvg(report: ReportInput, view: ReportView): string {
  const top = view.numbered.slice(0, 5);
  const rows = top.map((entry, index) => {
    const style = SEVERITY_STYLE[entry.finding.severity ?? 'none'];
    const y = 112 + index * 34;
    const label = `${entry.number} ${entry.finding.severity ?? 'unrated'}`;
    return `<rect x="24" y="${y - 20}" width="84" height="26" rx="3" fill="${style.color}"/><text x="32" y="${y - 2}" font-size="17" font-weight="700" fill="#ffffff" font-family="Arial, Helvetica, sans-serif">${escapeHtml(label)}</text>`
      + `<text x="120" y="${y - 2}" font-size="18" fill="#1b1b1b" font-family="Arial, Helvetica, sans-serif">${escapeHtml(entry.finding.caption)}</text>`;
  }).join('');
  const title = `${report.title}: ${VERDICT_WORD[view.overall]}`;
  const description = `${view.counts.failed} failed, ${view.counts.needsReview} need review, ${view.counts.passed} passed. Highest severity of failures: ${view.highest ?? 'none'}.`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 300" width="960" height="300" role="img" aria-labelledby="t-card d-card">`
    + `<title id="t-card">${escapeHtml(title)}</title><desc id="d-card">${escapeHtml(description)}</desc>`
    + `<rect width="960" height="300" fill="#ffffff" stroke="#c9ced6"/><rect width="960" height="64" fill="${VERDICT_COLOUR[view.overall]}"/>`
    + `<text x="24" y="44" font-size="32" font-weight="800" fill="#ffffff" font-family="Arial, Helvetica, sans-serif">${escapeHtml(VERDICT_WORD[view.overall])}</text>`
    + `<text x="936" y="42" font-size="20" fill="#ffffff" text-anchor="end" font-family="Arial, Helvetica, sans-serif">${view.counts.failed} failed, ${view.counts.needsReview} need review, ${view.counts.passed} passed</text>`
    + `<text x="24" y="92" font-size="16" fill="#4f4f4f" font-family="Arial, Helvetica, sans-serif">${escapeHtml(report.title)}</text>${rows}</svg>\n`;
}
