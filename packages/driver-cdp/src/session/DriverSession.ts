import type {
    BrowserDriver,
    BrowserRequestRecord,
    Result,
    Session,
    SessionEnvironment,
    Target,
    Unavailable,
} from "@revisum/contracts";
import type { PageFunction } from "../page/PageFunction.ts";

// A Session plus what evidence and measurement need from the own drivers.
export interface DriverSession extends Session {
    // The root process the driver started.
    readonly processId: number;
    // Evaluates a self-contained page function that returns a string (tests and evidence only).
    evaluate(
        pageFunction: PageFunction,
        inputs?: readonly (string | number | boolean)[],
    ): Promise<string>;
    // Every request the session's page, workers and popups sent, by origin and channel, in order.
    // Joined with the egress proxy's decisions, they make the run's egress events.
    egressRecords(): readonly BrowserRequestRecord[];
}

export interface OwnBrowserDriver extends BrowserDriver {
    open(
        target: Target,
        environment: SessionEnvironment,
    ): Promise<Result<DriverSession, Unavailable>>;
}
