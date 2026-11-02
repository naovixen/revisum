// Wraps the own CDP driver so each session hands over its browser's request records as it closes,
// since a run closes its session before it returns. Used by the plan run inside the run container,
// which prints them for the test outside.
import type { OwnBrowserDriver } from '@revisum/driver-cdp';
import type { BrowserDriver, BrowserRequestRecord, SessionEnvironment, Target } from '@revisum/engine';

export function keepingBrowserRecords(inner: OwnBrowserDriver, keep: (records: readonly BrowserRequestRecord[]) => void): BrowserDriver {
  return new Proxy(inner, {
    get(target, key) {
      if (key !== 'open') return Reflect.get(target, key, target);
      return async (openTarget: Target, environment: SessionEnvironment) => {
        const opened = await target.open(openTarget, environment);
        if (!opened.ok) return opened;
        const session = opened.value;
        const close = async (): Promise<void> => {
          try { keep(session.egressRecords()); } finally { await session.close(); }
        };
        const wrapped = new Proxy(session, {
          get(sessionTarget, sessionKey) {
            if (sessionKey === 'close') return close;
            const value: unknown = Reflect.get(sessionTarget, sessionKey, sessionTarget);
            return typeof value === 'function' ? value.bind(sessionTarget) : value;
          },
        });
        return { ok: true as const, value: wrapped };
      };
    },
  });
}
