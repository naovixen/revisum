// A driver is an adapter, and its port promises a Result rather than a throw. One that breaks that
// promise says nothing about the target, so this wrapper, the one place a run calls a driver, turns a
// throw or a rejection into a stated outcome: the run ends Errored on one before its session opens, and
// a session or tab whose close breaks its promise is reported the way any close that failed is.
import {
    failure,
    type AdapterInfo,
    type BrowserBuild,
    type BrowserDriver,
    type BuildFailure,
    type ClosedSession,
    type Result,
    type Session,
    type SessionEnvironment,
    type SessionTab,
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

const textOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const brokenDriver = (member: string, error: unknown): BrokenDriver => ({
    brokeItsPromise: `the driver's ${member} threw where it promises a result: ${textOf(error)}`,
});

// What a session left when its close gave no record: what it had noted by then. A session that cannot
// say that either still ends with a record, each of whose parts says why it could not be read.
export function recordsWithoutAClose(session: Session, closeFailure: string): ClosedSession {
    try {
        return { ...session.recordsSoFar(), closeFailure };
    } catch (error) {
        const unread = failure(textOf(error));
        return {
            blockedOrigins: unread,
            connectionFailures: unread,
            refusedRequestDecisions: unread,
            closeFailure,
        };
    }
}

// What a session left, and what its tabs did not say by rejecting. A tab's close has no record to leave,
// so what went wrong goes to its session's close, as its port says it does.
function withBrokenCloses(closed: ClosedSession, brokenCloses: readonly string[]): ClosedSession {
    if (brokenCloses.length === 0) {
        return closed;
    }
    const failures = [
        ...(closed.closeFailure === null ? [] : [closed.closeFailure]),
        ...brokenCloses,
    ];
    return { ...closed, closeFailure: failures.join("; ") };
}

// The value at a property of a port's object, its methods still bound to it, so a class instance
// behind a port works as a plain object does.
function propertyOf(target: object, property: string | symbol): unknown {
    const value: unknown = Reflect.get(target, property);
    return typeof value === "function" ? (value.bind(target) as unknown) : value;
}

function guardedTab(tab: SessionTab, brokenCloses: string[]): SessionTab {
    const close = async (): Promise<void> => {
        try {
            await tab.close();
        } catch (error) {
            brokenCloses.push(textOf(error));
        }
    };
    return new Proxy(tab, {
        get: (target, property): unknown =>
            property === "close" ? close : propertyOf(target, property),
    });
}

// The session a run holds: its own close and its tabs' closes never reject.
function guardedSession(session: Session): Session {
    const brokenCloses: string[] = [];
    const close = (): Promise<ClosedSession> =>
        session.close().then(
            (closed) => withBrokenCloses(closed, brokenCloses),
            (error: unknown) =>
                recordsWithoutAClose(session, [textOf(error), ...brokenCloses].join("; ")),
        );
    const newTab: Session["newTab"] = async (url) => {
        const opened = await session.newTab(url);
        return opened.ok ? { ok: true, value: guardedTab(opened.value, brokenCloses) } : opened;
    };
    return new Proxy(session, {
        get: (target, property): unknown => {
            if (property === "close") {
                return close;
            }
            return property === "newTab" ? newTab : propertyOf(target, property);
        },
    });
}

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
        open: async (target, environment) => {
            const opened = await keptPromise("open", () => driver.open(target, environment));
            return opened.ok ? { ok: true, value: guardedSession(opened.value) } : opened;
        },
        ...(build === undefined
            ? {}
            : { build: (target: Target) => keptPromise("build", () => build(target)) }),
    };
}
