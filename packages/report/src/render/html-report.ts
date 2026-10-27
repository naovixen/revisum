// The self-contained HTML report. Pure string building; every model string goes through
// escapeHtml(). No script, no outside resource, and no time except run.recordedAt from the run
// manifest.
import { PRODUCT } from '@revisum/contracts';
import { figureSvg, SEVERITY_STYLE } from '../annotated-screenshot.ts';
import { LEVEL_NAMES, LEVEL_RULES, levelSeries, metricsFor, type Level } from '../maturity-levels.ts';
import {
  SEVERITIES, type Criterion, type Finding, type History, type ImageMeta, type ReportInput, type Severity, type Verdict,
} from '../model/report-model.ts';
import { deriveView, type ImageFigure, type NumberedFinding, type ReportView } from '../report-view.ts';
import { escapeHtml, formatPercent } from '../text-safety.ts';
import { escapedDefectsChart, sharesChart } from './charts.ts';
import { REPORT_CSS } from './stylesheet.ts';

export const REPORT_GENERATOR = `${PRODUCT.name}-report/0.1.0`;
const KIND_LABEL = { a11y: 'Accessibility run', functional: 'Functional run', api: 'API and identity run' } as const;
const VERDICT_WORD: Readonly<Record<Verdict, string>> = { passed: 'PASSED', failed: 'FAILED', 'needs-review': 'NEEDS REVIEW' };
const VERDICT_MARK: Readonly<Record<Verdict, string>> = { passed: '✓', failed: '✗', 'needs-review': '?' };
const STATUS_WORD: Readonly<Record<Verdict, string>> = { passed: 'Passed', failed: 'Failed', 'needs-review': 'Needs review' };
const SEVERITY_MEANING: Readonly<Record<Severity, string>> = {
  P1: 'blocks a user or a core task', P2: 'serious problem; a workaround exists', P3: 'minor problem', P4: 'cosmetic or advisory',
};

export interface EmbeddedImages { readonly dataUris: ReadonlyMap<string, string> }

const severityPill = (finding: Finding): string =>
  `<span class="sev sev-${finding.severity ?? 'none'}">${finding.severity ?? 'unrated'}${finding.status === 'needs-review' ? ' ?' : ''}</span>`;
const criterionLinks = (finding: Finding): string => finding.criterionIds.map((id) => escapeHtml(id)).join(', ');
const labelledValue = (label: string, valueHtml: string): string => `<div class="kv"><strong>${label}</strong><div>${valueHtml}</div></div>`;
const captionedTable = (key: string, captionHtml: string): string => `<p class="cap" id="cap-${key}">${captionHtml}</p><table aria-labelledby="cap-${key}">`;
const criterionText = (criterion: Criterion): string => (criterion.kind === 'wcag'
  ? `WCAG 2.2 SC ${criterion.successCriterion} ${criterion.title} (level ${criterion.level})`
  : `Assertion: ${criterion.text}`);

function figure(prefix: string, image: ImageMeta, imageFigure: ImageFigure, dataUri: string, crop: boolean, id: string | null, caption: string): string {
  const svg = figureSvg({ prefix, image, dataUri, callouts: imageFigure.callouts, crop });
  return `<figure${id ? ` id="${escapeHtml(id)}"` : ''}>${svg}<figcaption>${escapeHtml(caption)}</figcaption></figure>`;
}

function calloutList(imageFigure: ImageFigure, limit: number): string {
  const entries = [
    ...imageFigure.callouts.map((callout) => ({ number: callout.number, finding: callout.finding, pageLevel: false })),
    ...imageFigure.pageLevel.map((entry) => ({ number: entry.number, finding: entry.finding, pageLevel: true })),
  ].sort((left, right) => left.number - right.number);
  const shown = entries.slice(0, limit);
  const items = shown.map((entry) =>
    `<li><span class="num">${entry.number}</span> ${severityPill(entry.finding)} <span>${escapeHtml(entry.finding.caption)}${entry.pageLevel ? ' <span class="pl">(page-level, no box)</span>' : ''}</span></li>`);
  const more = entries.length - shown.length;
  return `<ol class="callouts">${items.join('')}${more > 0 ? `<li class="pl">${more} more in the findings list</li>` : ''}</ol>`;
}

function banner(report: ReportInput, view: ReportView): string {
  const severity = view.highest === null ? 'none' : view.highest;
  return `<section id="verdict" class="banner v-${view.overall}" aria-labelledby="h-verdict">`
    + `<p class="kicker">${escapeHtml(KIND_LABEL[report.kind])}</p><h1 id="h-verdict">${escapeHtml(report.title)}</h1>`
    + `<p class="verdict"><span class="vword"><span aria-hidden="true">${VERDICT_MARK[view.overall]}</span> ${VERDICT_WORD[view.overall]}</span>`
    + `<span>Highest severity of failures: ${view.highest === null ? '<strong>none</strong>' : `<span class="sev sev-${severity}">${severity}</span>`}</span></p>`
    + `<ul class="counts"><li><strong>${view.counts.failed}</strong> failed</li><li><strong>${view.counts.needsReview}</strong> need review</li><li><strong>${view.counts.passed}</strong> passed</li></ul>`
    + `</section>`;
}

function topSection(report: ReportInput, view: ReportView, images: EmbeddedImages): string {
  const top = view.top;
  if (top !== null) {
    const image = report.images.find((candidate) => candidate.id === top.imageId);
    const uri = images.dataUris.get(top.imageId);
    if (image !== undefined && uri !== undefined) {
      return `<section id="top" aria-labelledby="h-top"><h2 id="h-top">Top problems</h2><div class="top-grid">`
        + figure('top', image, top, uri, true, null, `${image.alt}. Cropped to the problem area.`)
        + calloutList(top, 4) + `</div></section>`;
    }
  }
  const firstFailed = view.numbered.filter((entry) => entry.finding.status === 'failed').slice(0, 5);
  const items = firstFailed.map((entry) => `<li><span class="num">${entry.number}</span> ${severityPill(entry.finding)} <span>${escapeHtml(entry.finding.caption)}</span></li>`).join('');
  return `<section id="top" aria-labelledby="h-top"><h2 id="h-top">Top problems</h2>${firstFailed.length === 0 ? '<p>No failed findings.</p>' : `<ol class="callouts">${items}</ol>`}</section>`;
}

function findingsTable(view: ReportView): string {
  if (view.numbered.length === 0) return '<p>No findings.</p>';
  const rows = view.numbered.map((entry) => `<tr><th scope="row" class="n"><a href="#f-${entry.number}">${entry.number}</a></th><td>${severityPill(entry.finding)}</td>`
    + `<td>${entry.finding.status === 'failed' ? 'Failed' : 'Needs review'}</td><td>${escapeHtml(entry.finding.caption)}</td><td>${criterionLinks(entry.finding)}</td>`
    + `<td>${escapeHtml(entry.finding.rule)}</td><td>${escapeHtml(criterionText(entry.finding.criterion))}</td></tr>`);
  return `${captionedTable('findings', 'All findings, most severe first')}<thead><tr><th scope="col">#</th><th scope="col">Severity</th><th scope="col">Status</th>`
    + `<th scope="col">Finding</th><th scope="col">Spec item</th><th scope="col">Rule</th><th scope="col">Criterion</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

function gallery(report: ReportInput, view: ReportView, images: EmbeddedImages): string {
  const figures = view.figures.map((imageFigure) => {
    const image = report.images.find((candidate) => candidate.id === imageFigure.imageId);
    const uri = images.dataUris.get(imageFigure.imageId);
    if (image === undefined || uri === undefined) return '';
    const hasFindings = imageFigure.callouts.length + imageFigure.pageLevel.length > 0;
    const caption = `${image.alt}${imageFigure.callouts.length > 0 ? '. Cropped to the problem area.' : ''}`;
    return `<div>${figure(`g-${image.id}`, image, imageFigure, uri, true, `img-${image.id}`, caption)}`
      + (hasFindings ? calloutList(imageFigure, 50) : '<p class="pl">No findings on this screenshot.</p>') + '</div>';
  });
  return figures.length === 0 ? '<p>No screenshots in this run.</p>' : `<div class="gallery">${figures.join('')}</div>`;
}

function reviewQueue(view: ReportView): string {
  if (view.review.length === 0) return '<p>Nothing to review: no item needs a person.</p>';
  const rows = view.review.map((entry) => `<tr><th scope="row" class="n">${entry.number}</th><td>${severityPill(entry.finding)}</td><td>${escapeHtml(entry.finding.caption)}</td>`
    + `<td>${criterionLinks(entry.finding)}</td><td>${escapeHtml(entry.finding.reason ?? '')}</td><td>${escapeHtml(entry.finding.action ?? '')}</td></tr>`);
  return `${captionedTable('review', `${view.review.length} item${view.review.length === 1 ? '' : 's'} for a person`)}<thead><tr><th scope="col">#</th>`
    + `<th scope="col">Severity</th><th scope="col">Item</th><th scope="col">Spec item</th><th scope="col">Why a person is needed</th><th scope="col">What to do</th></tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table>`;
}

function exchangeBlock(exchange: Finding['exchanges'][number]): string {
  return `<figure class="ex" id="ex-${escapeHtml(exchange.id)}"><figcaption>${escapeHtml(exchange.method)} ${escapeHtml(exchange.path)} → ${exchange.status === null ? 'no response' : exchange.status}</figcaption>`
    + `<div class="pair"><div><h4>Request</h4><pre>${escapeHtml(exchange.requestLines.join('\n'))}</pre></div><div><h4>Response</h4><pre>${escapeHtml(exchange.responseLines.join('\n'))}</pre></div></div></figure>`;
}

function findingCard(entry: NumberedFinding): string {
  const finding = entry.finding;
  const criteria = finding.criterionIds.map((id) => escapeHtml(id)).join(', ');
  return `<article class="card c-${finding.severity ?? 'none'}" id="f-${entry.number}" aria-labelledby="h-f-${entry.number}">`
    + `<h3 id="h-f-${entry.number}"><span class="num">${entry.number}</span> ${severityPill(finding)} ${escapeHtml(finding.title)}</h3>`
    + labelledValue('Status', finding.status === 'failed' ? 'Failed' : 'Needs review')
    + labelledValue('Severity', finding.severity ?? 'unrated')
    + labelledValue('Rule or probe', escapeHtml(finding.rule)) + labelledValue('Criterion', escapeHtml(criterionText(finding.criterion)))
    + (criteria ? labelledValue('Acceptance criteria', criteria) : '')
    + (finding.reason !== null ? labelledValue('Why a person is needed', escapeHtml(finding.reason)) : '')
    + (finding.action !== null ? labelledValue('What to do', escapeHtml(finding.action)) : '')
    + labelledValue('Steps', `<ol>${finding.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>`)
    + (finding.log.length > 0 ? labelledValue('Log', `<pre>${escapeHtml(finding.log.join('\n'))}</pre>`) : '')
    + `${finding.exchanges.map(exchangeBlock).join('')}</article>`;
}

function traceability(report: ReportInput, view: ReportView): string {
  const findingNumbers = new Map(view.numbered.map((entry) => [entry.finding.id, entry.number]));
  // The strip is a picture to glance at, not a set of controls: a long run would otherwise add hundreds of tab stops.
  const strip = report.acceptance.map((criterion) =>
    `<li class="st-${criterion.status}"><span class="cell" role="img" aria-label="${escapeHtml(criterion.id)}: ${STATUS_WORD[criterion.status]}">${VERDICT_MARK[criterion.status]}</span></li>`).join('');
  // One link per row, to the first finding; other evidence is named in text. Few tab stops keep the page usable by keyboard.
  const evidenceLinks = (criterion: ReportInput['acceptance'][number]): string => {
    const first = criterion.evidence.findIndex((evidence) => evidence.kind === 'finding' && findingNumbers.has(evidence.id));
    return criterion.evidence.map((evidence, index) =>
      (index === first ? `<a href="#f-${findingNumbers.get(evidence.id) ?? 0}">${escapeHtml(evidence.label)}</a>` : escapeHtml(evidence.label))).join(', ');
  };
  const rows = report.acceptance.map((criterion) => `<tr id="ac-${escapeHtml(criterion.id)}"><th scope="row">${escapeHtml(criterion.id)}</th><td>${escapeHtml(criterion.text)}</td>`
    + `<td>${VERDICT_MARK[criterion.status]} ${STATUS_WORD[criterion.status]}</td>`
    + `<td>${criterion.stepIds.map((id) => escapeHtml(id)).join(', ')}</td><td>${evidenceLinks(criterion)}</td></tr>`);
  const stepRows = report.steps.map((step) => `<tr id="s-${escapeHtml(step.id)}"><th scope="row">${escapeHtml(step.id)}</th><td>${escapeHtml(step.text)}</td><td>${escapeHtml(step.result)}</td></tr>`);
  return `<p>Each cell is one acceptance criterion: ✓ passed, ✗ failed, ? needs review. The table below gives each one with its steps and evidence.</p>`
    + `<ol class="strip" aria-label="Acceptance criteria, in order">${strip}</ol>`
    + `${captionedTable('trace', 'Acceptance criterion, plan step, evidence')}<thead><tr><th scope="col">Criterion</th><th scope="col">Statement</th>`
    + `<th scope="col">Result</th><th scope="col">Plan steps</th><th scope="col">Evidence</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    + `<h3 id="steps">Plan steps and results</h3>`
    + `${captionedTable('steps', `${report.steps.length} plan steps`)}<thead><tr><th scope="col">Step</th><th scope="col">What it does</th><th scope="col">Result</th></tr></thead>`
    + `<tbody>${stepRows.join('')}</tbody></table>`;
}

function metricsPanel(history: History): string {
  const metrics = history.periods.map(metricsFor);
  const levels = levelSeries(history);
  const latest = metrics[metrics.length - 1];
  const level = (levels[levels.length - 1] ?? 0) as Level;
  if (latest === undefined) return '<p>No history.</p>';
  const earlier = metrics[metrics.length - 2];
  const tile = (name: string, value: string, previous: string | null): string =>
    `<div class="tile"><span>${escapeHtml(name)}</span><b>${value}</b>${previous === null ? '' : `<span class="muted">previous: ${previous}</span>`}</div>`;
  const escapedDefects = SEVERITIES.map((severity) => `<span class="sev sev-${severity}">${severity}</span> ${latest.escaped[severity]}`).join(' &nbsp; ');
  const ladder = ([0, 1, 2, 3, 4, 5] as const).map((step) =>
    `<li${step === level ? ' aria-current="step"' : ''}>Level ${step}: ${escapeHtml(LEVEL_NAMES[step])}${step === level ? ' (current)' : ''}</li>`).join('');
  const rows = history.periods.map((period, index) => {
    const periodMetrics = metrics[index];
    if (periodMetrics === undefined) return '';
    return `<tr><th scope="row">${escapeHtml(period.id)}</th><td>${period.escaped.P1}</td><td>${period.escaped.P2}</td><td>${period.escaped.P3}</td><td>${period.escaped.P4}</td>`
      + `<td>${formatPercent(periodMetrics.verifiedWithoutReviewShare)}</td><td>${formatPercent(periodMetrics.flakyRunRate)}</td>`
      + `<td>${formatPercent(periodMetrics.tracedCriteriaShare)}</td><td>${levels[index] ?? 0}</td></tr>`;
  });
  return (history.synthetic ? `<p class="demo">DEMO DATA: ${escapeHtml(history.label)}.</p>` : '')
    + `<div class="tiles">${tile(`Level ${level} of 5`, escapeHtml(LEVEL_NAMES[level]), null)}`
    + tile('Escaped defects, latest period', escapedDefects, null)
    + tile('Verified without manual review', formatPercent(latest.verifiedWithoutReviewShare), earlier ? formatPercent(earlier.verifiedWithoutReviewShare) : null)
    + tile('Flaky run rate', formatPercent(latest.flakyRunRate), earlier ? formatPercent(earlier.flakyRunRate) : null)
    + tile('Acceptance criteria traced', formatPercent(latest.tracedCriteriaShare), earlier ? formatPercent(earlier.tracedCriteriaShare) : null) + `</div>`
    + `<ol class="ladder" aria-label="Maturity levels">${ladder}</ol>`
    + `<p class="muted">Provisional definition for level ${level}: ${escapeHtml(LEVEL_RULES[level])}. A level counts only when every lower level also holds.</p>`
    + `<div class="gallery">${escapedDefectsChart(history, 'ch-esc')}${sharesChart(history, 'ch-shr')}</div>`
    + `${captionedTable('values', 'Values behind the charts, by period')}<thead><tr><th scope="col">Period</th><th scope="col">P1</th><th scope="col">P2</th>`
    + `<th scope="col">P3</th><th scope="col">P4</th><th scope="col">Verified</th><th scope="col">Flaky</th><th scope="col">Traced</th><th scope="col">Level</th></tr></thead>`
    + `<tbody>${rows.join('')}</tbody></table>`;
}

function footer(report: ReportInput): string {
  const legend = SEVERITIES.map((severity) =>
    `<li><span class="sev sev-${severity}">${severity}</span> ${escapeHtml(SEVERITY_MEANING[severity])}. Drawn as a ${escapeHtml(SEVERITY_STYLE[severity].word)}.</li>`).join('');
  const inputs = report.run.inputs.map((input) => `<tr><td>${escapeHtml(input.name)}</td><td>${escapeHtml(input.sha256.slice(0, 16))}</td></tr>`).join('');
  return `<footer><h2 id="manifest">Run manifest</h2>${labelledValue('Report', escapeHtml(report.reportId))}${labelledValue('Subject', escapeHtml(report.subject))}`
    + `${labelledValue('Run', escapeHtml(report.run.runId))}${labelledValue('Recorded', escapeHtml(report.run.recordedAt))}`
    + `${labelledValue('Target', escapeHtml(report.run.target))}${labelledValue('Tool', escapeHtml(report.run.tool))}`
    + `${labelledValue('Manifest hash', escapeHtml(report.run.manifestHash ?? 'none'))}${labelledValue('Generator', escapeHtml(REPORT_GENERATOR))}`
    + `<h3>Severity key (provisional)</h3><ul class="legend">${legend}<li><span class="sev sev-none">unrated</span> not yet rated by a person. A question mark after a severity means needs review.</li></ul>`
    + (inputs ? `${captionedTable('inputs', 'Inputs (first 16 hex digits of each SHA-256)')}<thead><tr><th scope="col">Input</th><th scope="col">SHA-256</th></tr></thead><tbody>${inputs}</tbody></table>` : '')
    + `</footer>`;
}

export function renderHtml(report: ReportInput, history: History, images: EmbeddedImages): string {
  const view = deriveView(report);
  const section = (id: string, title: string, body: string): string => `<section id="${id}" aria-labelledby="h-${id}"><h2 id="h-${id}">${title}</h2>${body}</section>`;
  const navigation = [['top', 'Top problems'], ['findings', 'Findings'], ['shots', 'Screenshots'], ['review', 'Review queue'], ['details', 'Details'], ['trace', 'Traceability'], ['metrics', 'Metrics']]
    .map(([id, title]) => `<li><a href="#${id}">${title}</a></li>`).join('');
  return `<!doctype html>\n<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`
    + `<title>${escapeHtml(report.title)} | evidence report</title><style>${REPORT_CSS}</style></head><body>`
    + `<a class="skip" href="#verdict">Skip to the verdict</a>`
    + `<header class="top"><p class="brand">${escapeHtml(PRODUCT.name)}</p><nav aria-label="Report sections"><ul>${navigation}</ul></nav></header>`
    + `<main id="main">${banner(report, view)}${topSection(report, view, images)}`
    + section('findings', 'Findings', (report.note === null ? '' : `<p class="muted">Note: ${escapeHtml(report.note)}</p>`) + findingsTable(view))
    + section('shots', 'Annotated screenshots', gallery(report, view, images))
    + section('review', `Review queue (${view.review.length})`, reviewQueue(view))
    + section('details', 'Finding details', view.numbered.map(findingCard).join('') || '<p>No findings.</p>')
    + section('trace', 'Traceability: criterion, step, evidence', traceability(report, view))
    + section('metrics', 'Metrics and maturity', metricsPanel(history))
    + `</main>${footer(report)}</body></html>\n`;
}
