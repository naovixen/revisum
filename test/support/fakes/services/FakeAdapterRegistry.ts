import type { AdapterRegistry, BrowserDriver } from "@revisum/engine";
import { fakeDriver } from "../session/FakeDriver.ts";
import { recordCalls, type Recorded } from "../RecordCalls.ts";

// A registry of the drivers given, by their own ids: one fake driver when none are.
export function fakeAdapterRegistry(
    drivers: readonly BrowserDriver[] = [fakeDriver()],
    overrides: Partial<AdapterRegistry> = {},
): Recorded<AdapterRegistry> {
    const defaults: Required<AdapterRegistry> = {
        all: () => drivers,
        find: (id) => drivers.find((driver) => driver.info.id === id) ?? null,
    };
    return recordCalls({ ...defaults, ...overrides });
}
