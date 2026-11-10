import type { Approval, ApprovalStore } from "@revisum/engine";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// A store holding the approvals given, and none when none are.
export function fakeApprovalStore(
    approvals: readonly Approval[] = [],
    overrides: Partial<ApprovalStore> = {},
): Recorded<ApprovalStore> {
    const defaults: Required<ApprovalStore> = {
        forSubject: (subjectHash) =>
            approvals.filter((approval) => approval.subject.hash === subjectHash),
    };
    return recordCalls({ ...defaults, ...overrides });
}
