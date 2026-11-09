import { hostAndPort } from "./HostAndPort.ts";
import type { SeenOrigin } from "../ports/Runner.ts";

// The one list of what was refused, so "https://x" and the tunnel "x:443" a proxy refused for it can't
// both appear. The browser's form says more, so it wins.
export function mergeRefusedOrigins(
    seenByBrowser: readonly SeenOrigin[],
    refusedByProxy: readonly SeenOrigin[],
): readonly SeenOrigin[] {
    const inBrowserForm = new Set(seenByBrowser.map(hostAndPort));
    const onlyProxySaw = new Map(
        refusedByProxy
            .filter((origin) => !inBrowserForm.has(hostAndPort(origin)))
            .map((origin) => [hostAndPort(origin), origin]),
    );
    return [...new Set(seenByBrowser), ...onlyProxySaw.values()];
}
