// generate(): a pure function from a validated report, its screenshots and the history to the
// output files. No clock, no randomness, no environment and no input or output: the same inputs
// always give the same bytes.
import { figureSvg } from './annotated-screenshot.ts';
import { REPORT_MANIFEST_SCHEMA, type History, type ValidReport } from './model/report-model.ts';
import { REPORT_GENERATOR, renderHtml } from './render/html-report.ts';
import { prComment, summaryCardSvg } from './render/pr-comment.ts';
import { deriveView } from './report-view.ts';
import { pngSize, sha256 } from './text-safety.ts';

export interface ReportAssets { readonly png: ReadonlyMap<string, Uint8Array> }
export interface Output { readonly name: string; readonly bytes: Uint8Array; readonly mediaType: string }

const encoder = new TextEncoder();

export function generate(input: ValidReport, assets: ReportAssets, history: History): readonly Output[] {
  const dataUris = new Map<string, string>();
  for (const image of input.images) {
    const bytes = assets.png.get(image.id);
    if (bytes === undefined) throw new Error(`missing screenshot bytes for ${image.id}`);
    const size = pngSize(bytes);
    if (sha256(bytes) !== image.sha256 || size === null || size.width !== image.width || size.height !== image.height) {
      throw new Error(`screenshot ${image.id} does not match its model entry`);
    }
    dataUris.set(image.id, `data:image/png;base64,${Buffer.from(bytes).toString('base64')}`);
  }
  const view = deriveView(input);
  const html = renderHtml(input, history, { dataUris });
  let svg: string;
  let alt: string;
  const topImage = view.top === null ? undefined : input.images.find((image) => image.id === view.top?.imageId);
  if (view.top !== null && topImage !== undefined) {
    svg = figureSvg({ prefix: 'pr', image: topImage, dataUri: dataUris.get(topImage.id) ?? '', callouts: view.top.callouts, crop: true, standalone: { widthPixels: 960 } });
    alt = `Top finding: ${view.top.callouts[0]?.finding.caption ?? topImage.alt}`;
  } else {
    svg = summaryCardSvg(input, view);
    alt = `Verdict card for ${input.title}`;
  }
  const comment = prComment(input, view, 'top-finding.svg', alt, 'report.html');
  const files: Output[] = [
    { name: 'report.html', bytes: encoder.encode(html), mediaType: 'text/html' },
    { name: 'pr-comment.md', bytes: encoder.encode(comment), mediaType: 'text/markdown' },
    { name: 'top-finding.svg', bytes: encoder.encode(svg), mediaType: 'image/svg+xml' },
  ];
  const manifest = {
    schema: REPORT_MANIFEST_SCHEMA, reportId: input.reportId, generator: REPORT_GENERATOR,
    run: { runId: input.run.runId, recordedAt: input.run.recordedAt, manifestHash: input.run.manifestHash },
    counts: view.counts, overall: view.overall, highestSeverity: view.highest, findings: input.findings.length,
    images: input.images.map((image) => ({ id: image.id, sha256: image.sha256, width: image.width, height: image.height, embedded: 'data-uri' })),
    outputs: files.map((file) => ({ name: file.name, sha256: sha256(file.bytes), bytes: file.bytes.length, mediaType: file.mediaType })),
  };
  return [...files, { name: 'manifest.json', bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`), mediaType: 'application/json' }];
}
