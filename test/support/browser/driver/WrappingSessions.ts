// Stand-ins for a driver and its sessions, for tests that watch or change one member and leave the
// rest real.
import type {
    BrowserDriver,
    ClosedSession,
    Session,
    SessionEnvironment,
    Target,
} from "@revisum/engine";

// The object with the named members replaced, and its other members its own.
function withMembers<Subject extends object>(
    subject: Subject,
    replaced: Readonly<Record<string, unknown>>,
): Subject {
    return new Proxy(subject, {
        get(target, key): unknown {
            if (typeof key === "string" && Object.hasOwn(replaced, key)) {
                return replaced[key];
            }
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

export const driverWith = <Driver extends BrowserDriver>(
    driver: Driver,
    replaced: Readonly<Record<string, unknown>>,
): Driver => withMembers(driver, replaced);

export const sessionWith = <OpenedSession extends Session>(
    session: OpenedSession,
    replaced: Readonly<Record<string, unknown>>,
): OpenedSession => withMembers(session, replaced);

// A session port, such as its clock or clipboard, with the named methods replaced. A port the
// session does not have stays as it is.
export const portWith = (port: unknown, replaced: Readonly<Record<string, unknown>>): unknown =>
    typeof port === "object" && port !== null ? withMembers(port, replaced) : port;

// A driver whose every session is replaced by what `wrap` makes of it.
export function wrappingSessions(
    inner: BrowserDriver,
    wrap: (session: Session) => Session,
): BrowserDriver {
    return driverWith(inner, {
        open: async (target: Target, environment: SessionEnvironment) => {
            const opened = await inner.open(target, environment);
            return opened.ok ? { ok: true as const, value: wrap(opened.value) } : opened;
        },
    });
}

// A driver whose sessions run `atClose` as their close() begins, before the inner session closes.
export const runningAtClose = (
    inner: BrowserDriver,
    atClose: (session: Session) => Promise<void>,
): BrowserDriver =>
    wrappingSessions(inner, (session) =>
        sessionWith(session, {
            close: async (): Promise<ClosedSession> => {
                let closed: ClosedSession;
                try {
                    await atClose(session);
                } finally {
                    closed = await session.close();
                }
                return closed;
            },
        }),
    );
