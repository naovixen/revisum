// Two small inline SVG charts for the metrics panel. Each has a <title> and <desc> and is paired
// with a data table in the page, so the numbers never depend on the graphic. Severity is told apart
// by fill pattern as well as colour; the three share lines differ by marker shape and dash.
import { metricsFor } from '../maturity-levels.ts';
import { SEVERITIES, type History, type Severity } from '../model/report-model.ts';
import { escapeHtml } from '../text-safety.ts';

const CHART_WIDTH = 720;
const CHART_HEIGHT = 250;
const MARGIN_LEFT = 40;
const MARGIN_RIGHT = 12;
const MARGIN_TOP = 16;
const MARGIN_BOTTOM = 44;
const SEVERITY_FILL: Readonly<Record<Severity, string>> = { P1: '#a50e0e', P2: '#a85200', P3: '#1a5fb4', P4: '#4a4a4a' };
const oneDecimal = (value: number): string => String(Math.round(value * 10) / 10);

function xAt(index: number, count: number): number {
  return MARGIN_LEFT + ((CHART_WIDTH - MARGIN_LEFT - MARGIN_RIGHT) * (index + 0.5)) / count;
}

export function escapedDefectsChart(history: History, id: string): string {
  const count = history.periods.length;
  const totals = history.periods.map((period) => SEVERITIES.reduce((sum, severity) => sum + period.escaped[severity], 0));
  const highestTotal = Math.max(1, ...totals);
  const plotHeight = CHART_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const barWidth = Math.min(36, ((CHART_WIDTH - MARGIN_LEFT - MARGIN_RIGHT) / count) * 0.62);
  const yOf = (value: number): number => MARGIN_TOP + plotHeight - (value / highestTotal) * plotHeight;
  const definitions = `<defs>`
    + `<pattern id="${id}-p1" width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="${SEVERITY_FILL.P1}"/></pattern>`
    + `<pattern id="${id}-p2" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#ffffff"/><path d="M-2 2l4-4M0 8l8-8M6 10l4-4" stroke="${SEVERITY_FILL.P2}" stroke-width="3"/></pattern>`
    + `<pattern id="${id}-p3" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#ffffff"/><circle cx="4" cy="4" r="2.2" fill="${SEVERITY_FILL.P3}"/></pattern>`
    + `<pattern id="${id}-p4" width="8" height="8" patternUnits="userSpaceOnUse"><rect width="8" height="8" fill="#ffffff"/><path d="M0 4h8" stroke="${SEVERITY_FILL.P4}" stroke-width="2"/></pattern>`
    + `</defs>`;
  const bars: string[] = [];
  const labels: string[] = [];
  history.periods.forEach((period, index) => {
    let stacked = 0;
    for (const severity of SEVERITIES) {
      const value = period.escaped[severity];
      if (value === 0) continue;
      const top = yOf(stacked + value);
      const bottom = yOf(stacked);
      bars.push(`<rect x="${oneDecimal(xAt(index, count) - barWidth / 2)}" y="${oneDecimal(top)}" width="${oneDecimal(barWidth)}" height="${oneDecimal(bottom - top)}" fill="url(#${id}-${severity.toLowerCase()})" stroke="${SEVERITY_FILL[severity]}" stroke-width="1.5"/>`);
      stacked += value;
    }
    labels.push(`<text x="${oneDecimal(xAt(index, count))}" y="${CHART_HEIGHT - MARGIN_BOTTOM + 16}" font-size="11" text-anchor="middle" fill="#1b1b1b">${escapeHtml(period.id)}</text>`);
    labels.push(`<text x="${oneDecimal(xAt(index, count))}" y="${oneDecimal(yOf(totals[index] ?? 0) - 4)}" font-size="11" text-anchor="middle" fill="#1b1b1b">${totals[index] ?? 0}</text>`);
  });
  const legend = SEVERITIES.map((severity, index) =>
    `<rect x="${MARGIN_LEFT + index * 70}" y="${CHART_HEIGHT - 16}" width="14" height="12" fill="url(#${id}-${severity.toLowerCase()})" stroke="${SEVERITY_FILL[severity]}" stroke-width="1.5"/><text x="${MARGIN_LEFT + index * 70 + 19}" y="${CHART_HEIGHT - 6}" font-size="12" fill="#1b1b1b">${severity}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-labelledby="${id}-t ${id}-d"><title id="${id}-t">Escaped defects per period, stacked by severity</title>`
    + `<desc id="${id}-d">Bars show escaped defects per period, split into P1 to P4. The numbers are in the table below the chart. Highest bar: ${highestTotal}.</desc>`
    + `${definitions}<line x1="${MARGIN_LEFT}" y1="${MARGIN_TOP + plotHeight}" x2="${CHART_WIDTH - MARGIN_RIGHT}" y2="${MARGIN_TOP + plotHeight}" stroke="#1b1b1b"/><line x1="${MARGIN_LEFT}" y1="${MARGIN_TOP}" x2="${MARGIN_LEFT}" y2="${MARGIN_TOP + plotHeight}" stroke="#1b1b1b"/>`
    + `<text x="${MARGIN_LEFT - 6}" y="${MARGIN_TOP + 10}" font-size="11" text-anchor="end" fill="#1b1b1b">${highestTotal}</text><text x="${MARGIN_LEFT - 6}" y="${MARGIN_TOP + plotHeight}" font-size="11" text-anchor="end" fill="#1b1b1b">0</text>`
    + `${bars.join('')}${labels.join('')}${legend}</svg>`;
}

type MarkerShape = 'circle' | 'square' | 'triangle';

export function sharesChart(history: History, id: string): string {
  const count = history.periods.length;
  const metrics = history.periods.map(metricsFor);
  const plotHeight = CHART_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM;
  const yOf = (value: number): number => MARGIN_TOP + plotHeight - Math.min(1, Math.max(0, value)) * plotHeight;
  const series: readonly { name: string; pick: (index: number) => number; dash: string; marker: MarkerShape; color: string }[] = [
    { name: 'Traced to spec', pick: (index) => metrics[index]?.tracedCriteriaShare ?? 0, dash: '', marker: 'circle', color: '#1a5fb4' },
    { name: 'Verified without review', pick: (index) => metrics[index]?.verifiedWithoutReviewShare ?? 0, dash: '8 4', marker: 'square', color: '#0b5d1e' },
    { name: 'Flaky runs', pick: (index) => metrics[index]?.flakyRunRate ?? 0, dash: '2 4', marker: 'triangle', color: '#a50e0e' },
  ];
  const marker = (shape: MarkerShape, x: number, y: number, color: string): string => shape === 'circle'
    ? `<circle cx="${oneDecimal(x)}" cy="${oneDecimal(y)}" r="4" fill="${color}"/>`
    : shape === 'square'
      ? `<rect x="${oneDecimal(x - 4)}" y="${oneDecimal(y - 4)}" width="8" height="8" fill="${color}"/>`
      : `<path d="M${oneDecimal(x)} ${oneDecimal(y - 5)}L${oneDecimal(x + 5)} ${oneDecimal(y + 4)}L${oneDecimal(x - 5)} ${oneDecimal(y + 4)}Z" fill="${color}"/>`;
  const lines = series.map((line) => {
    const points = history.periods.map((_, index) => `${oneDecimal(xAt(index, count))},${oneDecimal(yOf(line.pick(index)))}`).join(' ');
    const markers = history.periods.map((_, index) => marker(line.marker, xAt(index, count), yOf(line.pick(index)), line.color)).join('');
    return `<polyline points="${points}" fill="none" stroke="${line.color}" stroke-width="2.5"${line.dash ? ` stroke-dasharray="${line.dash}"` : ''}/>${markers}`;
  }).join('');
  const xLabels = history.periods.map((period, index) =>
    `<text x="${oneDecimal(xAt(index, count))}" y="${CHART_HEIGHT - MARGIN_BOTTOM + 16}" font-size="11" text-anchor="middle" fill="#1b1b1b">${escapeHtml(period.id)}</text>`).join('');
  const grid = [0, 0.5, 1].map((value) =>
    `<line x1="${MARGIN_LEFT}" y1="${oneDecimal(yOf(value))}" x2="${CHART_WIDTH - MARGIN_RIGHT}" y2="${oneDecimal(yOf(value))}" stroke="#c9ced6"/><text x="${MARGIN_LEFT - 6}" y="${oneDecimal(yOf(value) + 4)}" font-size="11" text-anchor="end" fill="#1b1b1b">${value * 100}%</text>`).join('');
  const legend = series.map((line, index) =>
    `${marker(line.marker, MARGIN_LEFT + index * 190 + 6, CHART_HEIGHT - 10, line.color)}<text x="${MARGIN_LEFT + index * 190 + 16}" y="${CHART_HEIGHT - 6}" font-size="12" fill="#1b1b1b">${line.name}</text>`).join('');
  return `<svg class="chart" viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" role="img" aria-labelledby="${id}-t ${id}-d"><title id="${id}-t">Traced, verified and flaky shares per period</title>`
    + `<desc id="${id}-d">Three lines per period: share of acceptance criteria traced to evidence, share of changes verified without manual review, and flaky run rate. The numbers are in the table below the chart.</desc>`
    + `${grid}<line x1="${MARGIN_LEFT}" y1="${MARGIN_TOP + plotHeight}" x2="${CHART_WIDTH - MARGIN_RIGHT}" y2="${MARGIN_TOP + plotHeight}" stroke="#1b1b1b"/>${lines}${xLabels}${legend}</svg>`;
}
