// Which approvals the verifier minted in this process. A copy, such as one read back from JSON, has the
// same fields and the plan's own hash and says nothing about who checked what, so a standing rests only
// on the very object the verifier gave. A WeakSet holds no approval alive and cannot be listed. Only
// the verifier records one, and index.ts does not export this.
import type { Approval } from "@revisum/contracts";

const minted = new WeakSet<Approval>();

export const mintedApprovals = {
    record(approval: Approval): void {
        minted.add(approval);
    },
    has(approval: Approval): boolean {
        return minted.has(approval);
    },
};
