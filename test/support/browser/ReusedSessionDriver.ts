import type { BrowserDriver, Session, SessionEnvironment, Target } from "@revisum/engine";
import { driverWith, sessionWith } from "./WrappingSessions.ts";

// A driver that opens one real session on its first open() and hands that same session to every
// later run, so many replays share one browser. Each run's close() leaves it open; closeAll() ends
// it. Every environment a run asked for is kept, so a test can show they were all the same.
export type ReusedSessionDriver = {
    readonly driver: BrowserDriver;
    readonly environments: readonly SessionEnvironment[];
    closeAll(): Promise<void>;
};

export function reusedSessionDriver(inner: BrowserDriver): ReusedSessionDriver {
    const environments: SessionEnvironment[] = [];
    const shared: { session: Session | null } = { session: null };
    const driver = driverWith(inner, {
        open: async (target: Target, environment: SessionEnvironment) => {
            environments.push(environment);
            if (shared.session === null) {
                const opened = await inner.open(target, environment);
                if (!opened.ok) {
                    return opened;
                }
                shared.session = opened.value;
            }
            const close = (): Promise<void> => Promise.resolve();
            return { ok: true as const, value: sessionWith(shared.session, { close }) };
        },
    });
    return {
        driver,
        environments,
        async closeAll() {
            const session = shared.session;
            shared.session = null;
            if (session !== null) {
                await session.close();
            }
        },
    };
}
