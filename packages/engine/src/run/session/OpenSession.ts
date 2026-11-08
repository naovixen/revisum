// Resolving the run's target to an open browser session.
import {
    UnavailableReason,
    type BrowserDriver,
    type Result,
    type Session,
    type Target,
    type Unavailable,
} from "@revisum/contracts";
import { totalClockAdvanceMilliseconds } from "../../clock-advance.ts";
import type { Planned } from "../../lifecycle.ts";
import { DETERMINISM_INPUTS } from "../../manifest.ts";
import { reachableOrigins } from "../../ReachableOrigins.ts";
import { resolvePlanClock } from "../../run-values.ts";
import { adapterRegistry } from "../../target/adapter-registry.ts";
import {
    guardedDriver,
    type BrokenDriver,
    type GuardedDriver,
} from "../../target/GuardedDriver.ts";
import { BROWSER_BUILD_INPUT, checkPinnedBuild } from "../../target/target-lock.ts";
import type { RunContext } from "../RunContext.ts";

export type OpenedSession = {
    readonly session: Session;
    readonly driver: GuardedDriver;
    // Inputs the run could not pin, for the manifest's nonHermeticInputs.
    readonly unpinned: readonly string[];
    // The sha256 of the executable the driver launched, when it reports its build.
    readonly executableSha256?: string;
};

// What opening a session needs of the run.
type OpenContext = Pick<RunContext, "cleared" | "inputs" | "ports">;

// True when the adapter the target names cannot pin the clock, the time zone or randomness.
export function cannotPinDeterminism(
    drivers: ReadonlyMap<string, BrowserDriver>,
    target: Target,
): boolean {
    const cannotPin = adapterRegistry(drivers).find(target.adapter)?.info.cannotPin ?? [];
    return cannotPin.some((input) => DETERMINISM_INPUTS.includes(input));
}

// Resolves the target in order, stopping at the first "no": only the adapter the target names is
// asked, it is asked once, and nothing else is tried in its place. The build is hashed, and
// checked against the lockfile when there is one, before anything launches.
export async function openSession(
    planned: Planned,
    context: OpenContext,
): Promise<Result<OpenedSession, Unavailable | BrokenDriver>> {
    const registered = adapterRegistry(context.ports.drivers).find(planned.target.adapter);
    if (registered === null) {
        return {
            ok: false,
            error: {
                reason: UnavailableReason.AdapterNotRegistered,
                detail: `no adapter '${planned.target.adapter}'`,
            },
        };
    }
    const driver = guardedDriver(registered);
    const supported = driver.supports(planned.target);
    if (!supported.ok) {
        return supported;
    }
    const checked = await checkPinnedBuild(driver, planned.target, context.inputs.lockEntries);
    if (!checked.ok) {
        return checked;
    }
    const unpinned = checked.value.unpinned ? [BROWSER_BUILD_INPUT] : [];
    const executableSha256 = checked.value.executableSha256;
    const opened = await driver.open(planned.target, {
        baseUrl: context.inputs.baseUrl,
        allowedOrigins: reachableOrigins(context.cleared),
        seed: context.inputs.seed,
        // The page sees the plan clock's time; the manifest keeps the run's own clock start.
        fixedTimeMilliseconds: resolvePlanClock(
            context.cleared.plan.clock,
            context.inputs.fixedTimeMilliseconds,
            planned.target.timezone,
        ),
        sensitiveSelectors: context.ports.redactor.selectors,
        timeoutMilliseconds: context.cleared.project.limits.stepTimeoutMilliseconds,
        // Only a plan that advances the clock puts the page's timers on virtual time; every other plan
        // keeps real-time timers, as pages that wait on their own timers need.
        ...(totalClockAdvanceMilliseconds(context.cleared.plan) > 0 ? { virtualTimers: true } : {}),
    });
    if (!opened.ok) {
        return opened;
    }
    return {
        ok: true,
        value: {
            session: opened.value,
            driver,
            unpinned,
            ...(executableSha256 === undefined ? {} : { executableSha256 }),
        },
    };
}
