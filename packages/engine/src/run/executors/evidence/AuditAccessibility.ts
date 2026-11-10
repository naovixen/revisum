import {
    AuditMode,
    StepCode,
    StepOutcome,
    stepFailed,
    type A11yFinding,
    type StepByType,
} from "@revisum/contracts";
import { codeOfFailedRead } from "../../CodeForThrow.ts";
import type { StepExecutor, StepNeeds } from "../StepExecutor.ts";
import { EventKind } from "../../logging/LoggingManifest.ts";

function byRuleId(left: A11yFinding, right: A11yFinding): number {
    if (left.ruleId === right.ruleId) {
        return 0;
    }
    return left.ruleId < right.ruleId ? -1 : 1;
}

// Audits the page as it stands. In report mode the findings are kept and the step passes; in gate
// mode any finding fails it.
export const auditAccessibility: StepExecutor<
    StepByType["a11yAudit"],
    StepNeeds<"document" | "logger" | "index">
> = async (step, context) => {
    const audited = await context.document.audit();
    if (!audited.ok) {
        return stepFailed(codeOfFailedRead(audited.error, context.logger));
    }
    const findings = [...audited.value].sort(byRuleId);
    context.logger.log({
        kind: EventKind.Audit,
        stepIndex: context.index,
        findings: findings.length,
    });
    if (step.mode === AuditMode.Report || findings.length === 0) {
        return { outcome: StepOutcome.Passed, findings };
    }
    // Findings stand before the code, as results have always recorded them.
    const { outcome, code } = stepFailed(StepCode.AccessibilityViolations);
    return { outcome, findings, code };
};
