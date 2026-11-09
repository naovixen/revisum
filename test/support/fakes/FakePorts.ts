import { unwiredPorts, type BrowserDriver, type RunPorts } from "@revisum/engine";
import { fakeArtifactStore } from "./ports/FakeArtifactStore.ts";
import { fakeClock } from "./session/FakeClock.ts";
import { fakeDriver } from "./session/FakeDriver.ts";
import { fakeEventSink } from "./ports/FakeEventSink.ts";
import { fakeRedactor } from "./ports/FakeRedactor.ts";
import { fakeRunEventSink } from "./ports/FakeRunEventSink.ts";
import { fakeRunIsolation } from "./session/FakeRunIsolation.ts";

// The drivers a run looks up, by each driver's own adapter id.
export const driversOf = (
    ...drivers: readonly BrowserDriver[]
): ReadonlyMap<string, BrowserDriver> => new Map(drivers.map((driver) => [driver.info.id, driver]));

// Every port a run takes, each one complete and harmless. A test that reads a port back gives its own
// fake here and keeps it. Secrets, services, database commands and rewrites default to the engine's
// unwired ports, as a run its caller wired nothing to gets them.
export function fakePorts(overrides: Partial<RunPorts> = {}): RunPorts {
    const defaults: RunPorts = {
        drivers: driversOf(fakeDriver()),
        clock: fakeClock(),
        artifacts: fakeArtifactStore(),
        redactor: fakeRedactor(),
        events: fakeRunEventSink(),
        audit: fakeEventSink(),
        isolation: fakeRunIsolation(),
        ...unwiredPorts,
    };
    return { ...defaults, ...overrides };
}
