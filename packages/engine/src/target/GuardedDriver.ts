// A driver is an adapter, and its port promises a Result rather than a throw. One that breaks that
// promise says nothing about the target, so this wrapper, the one place a run calls a driver before its
// session opens, turns a throw or a rejection into a stated outcome the run ends Errored on.
import {
    failure,
    type AdapterInfo,
    type BrowserBuild,
    type BrowserDriver,
    type BuildFailure,
    type Result,
    type Session,
    type SessionEnvironment,
    type Target,
    type Unavailable,
} from "@revisum/contracts";

// What a driver broke its promise with. The text goes only to the log, never into the result.
export type BrokenDriver = { readonly brokeItsPromise: string };

// The driver's ports as a run calls them: what each could say, or that it broke its promise.
export type GuardedDriver = {
    readonly info: AdapterInfo;
    supports(target: Target): Result<true, Unavailable | BrokenDriver>;
    open(
        target: Target,
        environment: SessionEnvironment,
    ): Promise<Result<Session, Unavailable | BrokenDriver>>;
    build?(target: Target): Promise<Result<BrowserBuild, BuildFailure | BrokenDriver>>;
};

export const isBrokenDriver = (failed: object): failed is BrokenDriver =>
    "brokeItsPromise" in failed;

const brokenDriver = (member: string, error: unknown): BrokenDriver => ({
    brokeItsPromise: `the driver's ${member} threw where it promises a result: ${
        error instanceof Error ? error.message : String(error)
    }`,
});

async function keptPromise<Value, Failed>(
    member: string,
    call: () => Promise<Result<Value, Failed>>,
): Promise<Result<Value, Failed | BrokenDriver>> {
    try {
        return await call();
    } catch (error) {
        return failure(brokenDriver(member, error));
    }
}

export function guardedDriver(driver: BrowserDriver): GuardedDriver {
    const build = driver.build?.bind(driver);
    return {
        info: driver.info,
        supports: (target) => {
            try {
                return driver.supports(target);
            } catch (error) {
                return failure(brokenDriver("supports", error));
            }
        },
        open: (target, environment) => keptPromise("open", () => driver.open(target, environment)),
        ...(build === undefined
            ? {}
            : { build: (target: Target) => keptPromise("build", () => build(target)) }),
    };
}
