// Why an evidence run ended as it did, beyond its tests' outcomes.
//   vacuous: the report holds no test that ran, so the run checked nothing and ends Failed.
//   suite-timeout: the suite ran past its timeout and was stopped; the run ends Errored.
//   setup-failed: the suite's setup command failed or timed out, so the suite never ran; Errored.
//   suite-report-unread: the suite's report is missing or was refused (decodeErrors says why); Errored.
//   egress-unread: what the egress proxy decided could not be read back, or not all of it was written,
//   so the run cannot show its egress was enforced; Errored.
export const EvidenceOutcomeCode = {
    Vacuous: "vacuous",
    SuiteTimeout: "suite-timeout",
    SetupFailed: "setup-failed",
    SuiteReportUnread: "suite-report-unread",
    EgressUnread: "egress-unread",
} as const;

export type EvidenceOutcomeCode = (typeof EvidenceOutcomeCode)[keyof typeof EvidenceOutcomeCode];
