import type { ActionGuard } from "@revisum/engine";
import { PolicyVerdictKind } from "@revisum/contracts";

// For a test about something other than the guard: a driver refuses any action it has no guard for.
export const allowEveryAction: ActionGuard = () => ({ kind: PolicyVerdictKind.Allow });
