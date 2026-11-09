// Why a suite's output was refused.
//   suite-report-missing: the suite wrote no report.
//   suite-report-invalid: the report does not have the shape of a Playwright Test JSON report.
//   suite-report-unsupported: the report comes from a reporter or version Revisum does not read.
//   trace-invalid, trace-unsupported: the same, for a trace archive.
//   too-large: the output is over a size, count or depth limit.
export const SuiteDecodeErrorCode = {
    SuiteReportMissing: "suite-report-missing",
    SuiteReportInvalid: "suite-report-invalid",
    SuiteReportUnsupported: "suite-report-unsupported",
    TraceInvalid: "trace-invalid",
    TraceUnsupported: "trace-unsupported",
    TooLarge: "too-large",
} as const;

export type SuiteDecodeErrorCode = (typeof SuiteDecodeErrorCode)[keyof typeof SuiteDecodeErrorCode];

// A bare code and JSON path, never a value from the suite's output.
export type SuiteDecodeError = { readonly code: SuiteDecodeErrorCode; readonly path: string };
