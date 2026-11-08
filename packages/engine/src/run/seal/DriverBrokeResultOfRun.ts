// A run whose driver broke its promise before any step: logged and sealed as Errored, with what it
// threw kept to the log, which redacts it.
import type { PlanRunResult } from "@revisum/contracts";
import type { BrokenDriver } from "../../target/GuardedDriver.ts";
import { logKeepingTheResult } from "../after-the-verdict/ReadKeepingTheResult.ts";
import { driverBrokeResult } from "./RefusedResult.ts";
import { runTimeOfNothingRan, sealResult, type NothingRanContext } from "./SealResult.ts";

export function driverBrokeResultOfRun(
    targetId: string,
    broken: BrokenDriver,
    context: NothingRanContext,
): PlanRunResult {
    logKeepingTheResult(
        { kind: "run.state", state: "Errored", targetId, detail: broken.brokeItsPromise },
        context.logger,
    );
    return sealResult(driverBrokeResult(targetId, runTimeOfNothingRan(context)), context);
}
