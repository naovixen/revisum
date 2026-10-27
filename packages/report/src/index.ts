// Public entry point: the visual evidence report, the pull-request comment and their model.
// See docs/specs/SPEC-12-visual-report-and-pr-comment.md.
export * from './model/report-model.ts';
export { parseHistory, parseReportInput } from './model/report-parser.ts';
export { generate, type Output, type ReportAssets } from './generate-report.ts';
export { deriveView, orderFindings, countVerdicts, type ImageFigure, type NumberedFinding, type ReportView } from './report-view.ts';
export { SEVERITY_STYLE, STROKE_DASH, usableBox, cropFor, figureSvg, type Callout } from './annotated-screenshot.ts';
export { LEVEL_NAMES, LEVEL_RULES, levelAt, levelSeries, metricsFor, type Level, type PeriodMetrics } from './maturity-levels.ts';
export { MAXIMUM_PR_COMMENT_CHARACTERS } from './render/pr-comment.ts';
export { REPORT_GENERATOR } from './render/html-report.ts';
export { contrast, markdownEscape, pngSize, sha256, wordCount } from './text-safety.ts';
