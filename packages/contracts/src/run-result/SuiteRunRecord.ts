import type { A11yFinding } from "../browser-driver.ts";
import type { SuiteFinding, SuiteName, SuiteTestResult } from "../evidence-mode.ts";

// An evidence run's tests, one per test and project, and the findings its failed tests became.
export type SuiteRunRecord = {
    readonly name: SuiteName;
    readonly tests: readonly SuiteTestResult[];
    readonly findings: readonly SuiteFinding[];
    // Present when the recorded pages were audited.
    readonly accessibilityFindings?: readonly A11yFinding[];
};
