import type { BrowserDriver, RunPorts } from "@revisum/engine";
import { fakeArtifactStore } from "./FakeArtifactStore.ts";
import { fakeClock } from "./FakeClock.ts";
import { fakeDatabaseCommandRunner } from "./FakeDatabaseCommandRunner.ts";
import { fakeDriver } from "./FakeDriver.ts";
import { fakeEventSink } from "./FakeEventSink.ts";
import { fakeRedactor } from "./FakeRedactor.ts";
import { fakeRunEventSink } from "./FakeRunEventSink.ts";
import { fakeRunIsolation } from "./FakeRunIsolation.ts";
import { fakeSecretStore } from "./FakeSecretStore.ts";
import { fakeServiceCaller } from "./FakeServiceCaller.ts";

// The drivers a run looks up, by each driver's own adapter id.
export const driversOf = (
    ...drivers: readonly BrowserDriver[]
): ReadonlyMap<string, BrowserDriver> => new Map(drivers.map((driver) => [driver.info.id, driver]));

// Every port a run takes, each one complete and harmless. A test that reads a port back gives its own
// fake here and keeps it; for a run that lacks an optional port, see leaveOut.
export function fakePorts(overrides: Partial<RunPorts> = {}): RunPorts {
    const defaults: Required<RunPorts> = {
        drivers: driversOf(fakeDriver()),
        clock: fakeClock(),
        artifacts: fakeArtifactStore(),
        redactor: fakeRedactor(),
        events: fakeRunEventSink(),
        audit: fakeEventSink(),
        isolation: fakeRunIsolation(),
        secrets: fakeSecretStore(),
        services: fakeServiceCaller(),
        databaseCommands: fakeDatabaseCommandRunner(),
        rewritesApplied: () => [],
    };
    return { ...defaults, ...overrides };
}
