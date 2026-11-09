// Public entry point: the visual evidence report, the pull-request comment and their model.
export * from './model/ReportKind.ts';
export { parseHistory, parseReportInput } from './model/ParseReportInput.ts';
export { generate, type Output, type ReportAssets } from './render/Generate.ts';
export { deriveView, orderFindings, countVerdicts, type ImageFigure, type NumberedFinding, type ReportView } from './model/ReportView.ts';
export { SEVERITY_STYLE, STROKE_DASH, usableBox, cropFor, figureSvg, type Callout } from './render/FigureSvg.ts';
export { LEVEL_NAMES, LEVEL_RULES, levelAt, levelSeries, metricsFor, type Level, type PeriodMetrics } from './model/LevelAt.ts';
export { MAXIMUM_PR_COMMENT_CHARACTERS } from './render/PrComment.ts';
export { REPORT_GENERATOR } from './render/RenderHtml.ts';
export { contrast, markdownEscape, pngSize, sha256, wordCount } from './model/CleanText.ts';
