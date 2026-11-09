// The adapters a run may use, looked up by the id a target names. There is no fallback: an
// unregistered id finds nothing, and no other adapter is offered in its place.
import type { AdapterId, AdapterRegistry, BrowserDriver } from '@revisum/contracts';

export function adapterRegistry(drivers: ReadonlyMap<string, BrowserDriver>): AdapterRegistry {
  const registered = [...drivers.values()];
  return {
    all: () => registered,
    find: (id: AdapterId) => drivers.get(id) ?? null,
  };
}
