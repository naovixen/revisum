// A run on a session that needs no browser, for tests that decide what the page does at each call:
// the session is typed to the real port and shows one element
// reading "Ready" until a test says otherwise. The plan goes through the real parser, policy gate
// and run, under a virtual clock, so a check that waits out its timeout costs no real time.
import assert from "node:assert/strict";
import {
    planParser,
    run,
    success,
    type BrowserDriver,
    type Clock,
    type ElementProbe,
    type NetworkPort,
    type ObservedExchange,
    type RunEventSink,
    type RunResult,
    type SecretStore,
    type Session,
    type StepResult,
} from "@revisum/engine";
import { type MemoryEventSink } from "../../support/memory-ports.ts";
import { baseUrlOf, clearRun, trustedProjectFrom } from "../../support/policy-clearance.ts";
import {
    DATABASE_PASSWORD,
    fakeCommandRunner,
    type CommandRoute,
} from "./database-command-examples.ts";
import { routedServiceCaller, type Route } from "./service-call-examples.ts";
import { DEFAULT_CLOCK_START, DEFAULT_SEED, ORIGIN } from "./run-value-examples.ts";
import { parsedProject, sourceBytes } from "./unsafe-feature-examples.ts";
import { DATABASE_SECRET, unsafeProjectFile, type JsonRecord } from "./unsafe-feature-steps.ts";
import { fakeClock } from "#test-support/fakes/FakeClock.ts";
import { fakeDriver } from "#test-support/fakes/FakeDriver.ts";
import { fakeEventSink } from "#test-support/fakes/FakeEventSink.ts";
import { fakeNetworkPort } from "#test-support/fakes/FakeNetworkPort.ts";
import { FAKE_ELEMENT } from "#test-support/fakes/FakePage.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { fakeRunEventSink } from "#test-support/fakes/FakeRunEventSink.ts";
import { fakeSecretStore } from "#test-support/fakes/FakeSecretStore.ts";
import { fakeSession } from "#test-support/fakes/FakeSession.ts";

export const SHOWN_ELEMENT: ElementProbe = { ...FAKE_ELEMENT, value: "Ready" };
export const NO_ELEMENT: ElementProbe = { count: 0 };

// A session whose frames and tabs are the session itself, unless `changes` says otherwise.
export const fakeSessionOnOrders = (changes: Partial<Session> = {}): Session =>
    fakeSession({
        page: () =>
            Promise.resolve(
                success({
                    url: `${ORIGIN}/orders`,
                    title: "Orders",
                    meta: [],
                    canonicalUrl: null,
                }),
            ),
        probe: () => Promise.resolve(SHOWN_ELEMENT),
        ...changes,
    });

// A network port that knows only what it has recorded, as the real one does: it has no idea whether
// the page is still alive.
export const fakeNetwork = (exchanges: readonly ObservedExchange[] = []): NetworkPort =>
    fakeNetworkPort({ exchanges: () => exchanges });

// One finished exchange of the shared project's "likes" request.
export const likesExchange = (status: number, firstName: string): ObservedExchange => ({
    method: "GET",
    url: `${ORIGIN}/api/transactions/likes`,
    status,
    mediaType: "application/json",
    body: new TextEncoder().encode(JSON.stringify({ results: [{ name: firstName }] })),
    stubbed: null,
});

export type FakeRunOptions = {
    readonly session?: Session;
    readonly projectFile?: JsonRecord;
    readonly serviceRoute?: Route;
    readonly commandRoute?: CommandRoute;
    readonly events?: RunEventSink;
    readonly secrets?: SecretStore;
    readonly clock?: Clock;
    // What opening the browser does, when a test needs it to do other than give `session`.
    readonly open?: BrowserDriver["open"];
};

export type FakeRun = {
    readonly result: RunResult;
    readonly audit: MemoryEventSink;
    readonly events: RunEventSink;
};

export async function runOnFakeSession(
    raw: unknown,
    options: FakeRunOptions = {},
): Promise<FakeRun> {
    const projectFile = options.projectFile ?? unsafeProjectFile();
    const project = parsedProject(projectFile);
    const parsed = planParser(project)(raw);
    assert.ok(parsed.ok, `the plan was rejected: ${JSON.stringify(parsed)}`);
    const trusted = await trustedProjectFrom(projectFile);
    const target = project.matrix[0];
    assert.ok(target !== undefined, "the test project has a target");
    const session = options.session ?? fakeSessionOnOrders();
    const driver = fakeDriver({
        open: options.open ?? (() => Promise.resolve(success(session))),
    });
    const audit = fakeEventSink();
    const events = options.events ?? fakeRunEventSink();
    const result = await run(
        clearRun(parsed.value, trusted, target.id),
        {
            baseUrl: baseUrlOf(ORIGIN),
            seed: DEFAULT_SEED,
            fixedTimeMilliseconds: DEFAULT_CLOCK_START,
            fixtures: [],
            host: { platform: "test", arch: "test" },
            scriptSources: sourceBytes(),
        },
        fakePorts({
            drivers: driversOf(driver),
            clock: options.clock ?? fakeClock(),
            audit,
            events,
            secrets: options.secrets ?? fakeSecretStore({ [DATABASE_SECRET]: DATABASE_PASSWORD }),
            services: routedServiceCaller(options.serviceRoute).caller,
            databaseCommands: fakeCommandRunner(options.commandRoute).port,
        }),
    );
    return { result, audit, events };
}

// Every value held under `key` anywhere in the step's result, however the result nests it, so a test
// says what a person must be able to read without fixing where it is kept.
export function recordsNamed(step: StepResult | undefined, key: string): readonly unknown[] {
    assert.ok(step !== undefined, "the step has a result");
    const found: unknown[] = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            value.forEach(visit);
            return;
        }
        if (typeof value !== "object" || value === null) {
            return;
        }
        for (const [name, nested] of Object.entries(value)) {
            if (name === key) {
                found.push(nested);
            }
            visit(nested);
        }
    };
    visit(JSON.parse(JSON.stringify(step)));
    return found;
}

export const stepSummaries = (
    result: RunResult,
): readonly (readonly [string, string | undefined])[] =>
    result.steps.map((step) => [step.outcome, step.code] as const);
