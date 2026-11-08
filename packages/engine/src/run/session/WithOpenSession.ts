// The scope a run's open session lives in: once it opens, it closes, whatever the use of it throws.
import { success, type ClosedSession, type Result, type Unavailable } from "@revisum/contracts";
import type { Planned } from "../../lifecycle.ts";
import type { RunContext } from "../RunContext.ts";
import { closeKeepingTheResult } from "./CloseKeepingTheResult.ts";
import { openSession, type OpenedSession } from "./OpenSession.ts";

// What opening and closing a session needs of the run.
type SessionScopeContext = Pick<RunContext, "cleared" | "inputs" | "ports" | "logger">;

// What `use` gave, and what the session left once it closed.
export type UsedSession<Value> = { readonly used: Value; readonly closed: ClosedSession };

// Opens the session, gives it to `use`, and closes it once `use` has settled. A target that cannot be
// opened gives why, and `use` never runs.
export async function withOpenSession<Value>(
    planned: Planned,
    context: SessionScopeContext,
    use: (opened: OpenedSession) => Promise<Value>,
): Promise<Result<UsedSession<Value>, Unavailable>> {
    const opened = await openSession(planned, context);
    if (!opened.ok) {
        return opened;
    }
    let used: Value;
    try {
        used = await use(opened.value);
    } catch (error) {
        await closeKeepingTheResult(opened.value.session, context.ports.clock, context.logger);
        throw error;
    }
    const closed = await closeKeepingTheResult(
        opened.value.session,
        context.ports.clock,
        context.logger,
    );
    return success({ used, closed });
}
