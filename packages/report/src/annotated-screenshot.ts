// Annotated screenshots: an inline SVG whose <image> is the original PNG (base64 of the unchanged
// bytes) with callouts drawn over it. Severity is shown by colour and also by a number, a text
// label and a stroke pattern, so no meaning rests on colour alone.
import type { Finding, ImageMeta, PixelBox, Severity } from './model/report-model.ts';
import { escapeHtml } from './text-safety.ts';

export const SEVERITY_STYLE: Readonly<Record<Severity | 'none', { color: string; dash: string; width: number; word: string }>> = {
  P1: { color: '#a50e0e', dash: '', width: 4, word: 'solid line' },
  P2: { color: '#a85200', dash: '10 5', width: 3, word: 'dashed line' },
  P3: { color: '#1a5fb4', dash: '2 5', width: 3, word: 'dotted line' },
  P4: { color: '#4a4a4a', dash: '14 4 3 4', width: 2, word: 'dash-dot line' },
  none: { color: '#5b3a8c', dash: '6 3', width: 3, word: 'short dashes' },
};
export const STROKE_DASH = (severity: Severity | null): string => SEVERITY_STYLE[severity ?? 'none'].dash;

export interface Callout { readonly number: number; readonly finding: Finding; readonly box: PixelBox }

// The box clamped to the image, or null when it has no area inside the image (a page-level finding).
export function usableBox(box: PixelBox | null, width: number, height: number): PixelBox | null {
  if (box === null) return null;
  const left = Math.max(0, box.x);
  const top = Math.max(0, box.y);
  const right = Math.min(width, box.x + box.width);
  const bottom = Math.min(height, box.y + box.height);
  if (!(right - left > 0) || !(bottom - top > 0) || box.width <= 0 || box.height <= 0) return null;
  const round = (value: number): number => Math.round(value * 100) / 100;
  return { x: round(left), y: round(top), width: round(right - left), height: round(bottom - top) };
}

type ViewArea = { x: number; y: number; width: number; height: number };

// A viewBox around the callouts, with the image's aspect ratio, inside the image.
export function cropFor(boxes: readonly PixelBox[], width: number, height: number): ViewArea {
  if (boxes.length === 0) return { x: 0, y: 0, width, height };
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  const aspect = width / height;
  const padding = Math.max(32, Math.round(0.25 * Math.max(right - left, bottom - top)));
  let cropWidth = Math.max(right - left + 2 * padding, Math.min(360, width));
  let cropHeight = Math.max(bottom - top + 2 * padding, cropWidth / aspect);
  cropWidth = Math.max(cropWidth, cropHeight * aspect);
  cropHeight = cropWidth / aspect;
  if (cropWidth >= width) { cropWidth = width; cropHeight = height; }
  const centreX = (left + right) / 2;
  const centreY = (top + bottom) / 2;
  const x = Math.min(Math.max(0, centreX - cropWidth / 2), width - cropWidth);
  const y = Math.min(Math.max(0, centreY - cropHeight / 2), height - cropHeight);
  return { x: Math.round(x), y: Math.round(y), width: Math.round(cropWidth), height: Math.round(cropHeight) };
}

export const calloutLabel = (number: number, finding: Finding): string =>
  `${number} ${finding.severity ?? 'unrated'}${finding.status === 'needs-review' ? ' ?' : ''}`;

const overlaps = (first: ViewArea, second: ViewArea): boolean =>
  first.x < second.x + second.width && second.x < first.x + first.width && first.y < second.y + second.height && second.y < first.y + first.height;
const formatNumber = (value: number): string => String(Math.round(value * 100) / 100);

export interface FigureOptions {
  readonly prefix: string;
  readonly image: ImageMeta;
  readonly dataUri: string;
  readonly callouts: readonly Callout[];
  readonly crop: boolean;
  // A standalone SVG document (its own xmlns, a fixed size) instead of an inline element.
  readonly standalone?: { readonly widthPixels: number };
}

export function figureSvg(options: FigureOptions): string {
  const { image, callouts } = options;
  const view = options.crop ? cropFor(callouts.map((callout) => callout.box), image.width, image.height) : { x: 0, y: 0, width: image.width, height: image.height };
  const fontSize = Math.max(12, Math.round(view.width / 40));
  const labelHeight = Math.round(fontSize * 1.55);
  const placed: ViewArea[] = [];
  const parts: string[] = [];
  for (const callout of callouts) {
    const style = SEVERITY_STYLE[callout.finding.severity ?? 'none'];
    const label = calloutLabel(callout.number, callout.finding);
    const labelWidth = Math.round(label.length * fontSize * 0.62 + fontSize);
    let labelX = Math.min(Math.max(view.x, callout.box.x), view.x + view.width - labelWidth);
    let labelY = callout.box.y - labelHeight >= view.y ? callout.box.y - labelHeight : callout.box.y;
    let area: ViewArea = { x: labelX, y: labelY, width: labelWidth, height: labelHeight };
    // Move the label down, or up and right, until it overlaps no earlier label.
    for (let i = 0; i < 8 && placed.some((earlier) => overlaps(earlier, area)); i++) {
      labelY += labelHeight;
      area = { x: labelX, y: labelY, width: labelWidth, height: labelHeight };
      if (labelY + labelHeight > view.y + view.height) {
        labelY = Math.max(view.y, callout.box.y - labelHeight * (i + 2));
        labelX = labelX + 4;
        area = { x: labelX, y: labelY, width: labelWidth, height: labelHeight };
      }
    }
    placed.push(area);
    const dash = style.dash === '' ? '' : ` stroke-dasharray="${style.dash}"`;
    const box = callout.box;
    parts.push(
      `<g class="co co-${callout.finding.severity ?? 'none'}" data-n="${callout.number}">`
      + `<rect x="${formatNumber(box.x)}" y="${formatNumber(box.y)}" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" fill="none" stroke="#ffffff" stroke-width="${style.width + 3}" vector-effect="non-scaling-stroke"/>`
      + `<rect class="box" x="${formatNumber(box.x)}" y="${formatNumber(box.y)}" width="${formatNumber(box.width)}" height="${formatNumber(box.height)}" fill="none" stroke="${style.color}" stroke-width="${style.width}"${dash} vector-effect="non-scaling-stroke"/>`
      + `<rect x="${formatNumber(area.x)}" y="${formatNumber(area.y)}" width="${labelWidth}" height="${labelHeight}" rx="3" fill="${style.color}" stroke="#ffffff" stroke-width="1" vector-effect="non-scaling-stroke"/>`
      + `<text x="${formatNumber(area.x + fontSize / 2)}" y="${formatNumber(area.y + labelHeight * 0.72)}" font-size="${fontSize}" font-weight="700" fill="#ffffff" font-family="Arial, Helvetica, sans-serif" textLength="${labelWidth - fontSize}" lengthAdjust="spacingAndGlyphs">${escapeHtml(label)}</text>`
      + '</g>',
    );
  }
  const title = `Screenshot: ${image.alt}`;
  const description = callouts.length === 0 ? 'No callouts on this screenshot.'
    : `Callouts: ${callouts.map((callout) => `${calloutLabel(callout.number, callout.finding)} ${callout.finding.caption}`).join('; ')}.`;
  const titleId = `t-${options.prefix}`;
  const descriptionId = `d-${options.prefix}`;
  const body = `<title id="${titleId}">${escapeHtml(title)}</title><desc id="${descriptionId}">${escapeHtml(description)}</desc>`
    + `<image href="${options.dataUri}" x="0" y="0" width="${image.width}" height="${image.height}"/>${parts.join('')}`;
  const viewBox = `${view.x} ${view.y} ${view.width} ${view.height}`;
  if (options.standalone) {
    const width = options.standalone.widthPixels;
    const height = Math.round((width * view.height) / view.width);
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" role="img" aria-labelledby="${titleId} ${descriptionId}">${body}</svg>\n`;
  }
  return `<svg class="shot" viewBox="${viewBox}" role="img" aria-labelledby="${titleId} ${descriptionId}">${body}</svg>`;
}
