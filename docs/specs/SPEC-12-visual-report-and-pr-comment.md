# SPEC-12: Visual report and PR comment

## Purpose

Make the evidence readable at a glance (evidence-rich findings, R12; a marketable interface, FD-4). It serves "AI writes features faster than we can check them" (UP-01), "accessibility audits take weeks" (UP-03) and "bug reports don't show what broke" (UP-06): the verdict, the worst problem and where it is are visible on the first screen and in the pull request, without reading prose.

## Scope and non-goals

- **In:** the report-renderer spike (P6) taken to product: a single-file HTML report with no script and no network requests; verdict banner first; one cropped, annotated screenshot on the first screen; severity shown by number, label, stroke pattern and colour; captions of 15 words or fewer from rule templates; finding cards; review-queue section; traceability strip; grouping by severity and paging at real scale; a PR comment with one annotated image and a report link, falling back to the job summary; the report itself accessible.
- **Non-goals:** a local review UI (until the interface research's third trigger fires, research `11`) or hosted dashboard (SPEC-24); an MCP Apps view (SPEC-18).

## Interfaces and types

```ts
export type ReportModel = { readonly result: RunResult; readonly reviewQueue: readonly ReviewItem[];
  readonly trace: readonly TraceRow[]; readonly images: readonly ArtifactReference[] };      // masked images only
export type ReportError = { readonly code: 'missing-field' | 'bad-value' | 'too-large'; readonly path: string };
export type ReportInput = Brand<ReportModel, 'ReportInput'>;
export function parseReportInput(input: unknown): Result<ReportInput, readonly ReportError[]>;
export function renderReport(input: ReportInput): { html: string; topFindingSvg: string };
export function renderPrComment(input: ReportInput, reportUrl: string): string; // Markdown, <= 1,800 chars
export type ReportLimits = { firstScreenMaximumWords: 120; captionMaximumWords: 15; maximumHtmlBytes: 2_000_000; findingsPerPage: number };
```

## Acceptance criteria

- AC-SPEC-12-01: When a report is generated, it shall contain no `<script>`, no event-handler attribute and no reference to a network URL, and loading it with all non-`file:` requests blocked shall show zero blocked requests (oracle: specified; reuses AC-p6-01 and AC-p6-03).
- AC-SPEC-12-02: When all reports are generated twice in one process and once in another from the same input, every output file shall be byte-identical (oracle: regression; reuses AC-p6-20).
- AC-SPEC-12-03: When the first screen renders at 1280x800, it shall show the verdict banner and at least one complete callout, and carry 120 words or fewer (oracle: specified; reuses AC-p6-27).
- AC-SPEC-12-04: When any two severities are shown, they shall differ in label and stroke pattern, not only colour (oracle: specified; reuses AC-p6-08).
- AC-SPEC-12-05: When hostile strings sit in any free-text field, the output shall contain them escaped or neutralised (oracle: specified; reuses AC-p6-22).
- AC-SPEC-12-06: When the report is built, both accessibility engines shall report zero violations on it (oracle: specified; reuses AC-p6-25 and AC-p6-26).
- AC-SPEC-12-07: When a run has more findings than one page holds, the report shall group them by severity and page them, keeping the first screen within its word cap (oracle: specified).
- AC-SPEC-12-08: When the PR comment is rendered, it shall have one verdict line with counts, exactly one image, at least one report link, at most 5 findings and at most 1,800 characters (oracle: specified; reuses AC-p6-18).
- AC-SPEC-12-09: When the image cannot be attached with the available token, the Action shall post the job summary with an artefact link instead (oracle: specified).
- AC-SPEC-12-10: When any image is embedded or attached, it shall be the masked capture (oracle: specified).

## Dependencies

- SPEC-11; SPEC-09 for masked images. The report-renderer spike's renderer (P6).
- Research background: interface (`11` Findings 2 and 3).

## Milestone

M3.

## Satisfies

FR-14, FR-15, NFR-11
