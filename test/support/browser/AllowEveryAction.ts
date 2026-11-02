import type { ActionGuard } from "@revisum/engine";

// For a test about something other than the guard: a driver refuses any action it has no guard for.
export const allowEveryAction: ActionGuard = () => ({ kind: "allow" });
