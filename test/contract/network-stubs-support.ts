// Shared setup for the browser tests of the plan language's declared network stubs, request checks
// and web storage: the driver parts of each, carried out by the own CDP driver over CDP's Fetch,
// Network and DOMStorage domains.
//
// It serves the network-stubs fixture app (fixtures/network-stubs-app/) twice, on two loopback
// ports, so storage can be written on one origin while the page is on the other. Beside the app's
// files it answers routes the tests build: JSON, text and slow answers under /api/, the server's
// own script, style sheet, frame, worker, image and page under /api/assets/, and the account page
// with a name made fresh for the harness. Every /api/ answer the server gives says
// "source": "server", so a page can tell it from a stub's answer.
//
// The trusted project is in NetworkProjectFile.ts.
// Every run reads the page just before the run closes its session, before an optional test hook.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserDriver, Plan, RunResult, StepResult } from "@revisum/engine";
import {
    startBrowserHarness,
    type BrowserHarness,
    type BrowserRun,
    type BrowserRunOptions,
} from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/CreateBrowserDriver.ts";
import { rawPlan, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import {
    startFixtureServer,
    type FixtureResponse,
    type FixtureRoute,
    type FixtureServer,
} from "#test-support/fixture-server.ts";
import { FIXTURES } from "#test-support/repository.ts";
import { letterNonce } from "../unit/engine/secret-examples.ts";
import { MARKUP_FIXTURE, networkProjectFile } from "./NetworkProjectFile.ts";

const SEED = 33;
// The run's own clock start: 30 October 2026, 12:00 UTC.
const CLOCK_START_MILLISECONDS = Date.UTC(2026, 9, 30, 12, 0, 0);
export const FIXTURE_FOLDER = join(FIXTURES, "network-stubs-app");
// The items /api/items answers with: twelve, so an array length is a two-digit number.
export const ITEM_NAMES = [
    "Kettle",
    "Toaster",
    "Blender",
    "Teapot",
    "Grill",
    "Mixer",
    "Juicer",
    "Steamer",
    "Fryer",
    "Scales",
    "Whisk",
    "Ladle",
] as const;
export const NEXT_PAGE_FIRST_ITEM = "Colander";

const networkDrivers = (): ReadonlyMap<string, BrowserDriver> =>
    driversForTargets([BrowserTarget.Chrome], { fixturesFolder: FIXTURE_FOLDER });

export const startStub = (name: string, stubArguments?: JsonRecord): JsonRecord => ({
    type: "stub",
    stub: name,
    action: "start",
    ...(stubArguments === undefined ? {} : { arguments: stubArguments }),
});
export const stopStub = (name: string): JsonRecord => ({
    type: "stub",
    stub: name,
    action: "stop",
});
export const resetRequests = (name: string): JsonRecord => ({
    type: "resetRequests",
    request: name,
});
export const expectRequests = (
    name: string,
    count: JsonRecord,
    criterionId: string,
): JsonRecord => ({
    type: "expectRequests",
    request: name,
    count,
    criterionId,
});
export const expectResponse = (
    name: string,
    assertion: JsonRecord,
    criterionId: string,
): JsonRecord => ({ type: "expectResponse", request: name, assert: assertion, criterionId });
export const rememberResponse = (
    valueName: string,
    request: string,
    field: string,
    read: "text" | "arrayLength",
): JsonRecord => ({ type: "remember", name: valueName, from: { response: request, field, read } });
export const setStorage = (entry: string, entryArguments?: JsonRecord): JsonRecord => ({
    type: "setStorage",
    entry,
    ...(entryArguments === undefined ? {} : { arguments: entryArguments }),
});
export const removeStorage = (entry: string): JsonRecord => ({ type: "removeStorage", entry });
export const expectStorage = (
    entry: string,
    assertion: JsonRecord,
    criterionId: string,
): JsonRecord => ({ type: "expectStorage", entry, assert: assertion, criterionId });
export const titleIs = (value: string, criterionId: string): JsonRecord => ({
    type: "expectPage",
    assert: { kind: "title", value },
    criterionId,
});

export const networkPlan = (
    targetId: string,
    steps: readonly unknown[],
    fields: JsonRecord = {},
): JsonRecord =>
    rawPlan(
        {
            featureId: "STUBS-1",
            specReference: "specs/network-stubs.md#driver",
            title: "Stubs, request checks and storage in a browser",
        },
        targetId,
        steps,
        fields,
    );

// The stub names a step result lists as active while it ran, sorted; none when it lists none.
export function activeStubsOf(step: StepResult | undefined): readonly string[] {
    assert.ok(step !== undefined, "the step has a result");
    const fields: Readonly<Record<string, unknown>> = { ...step };
    const listed = fields["activeStubs"];
    if (listed === undefined) {
        return [];
    }
    assert.ok(Array.isArray(listed), `activeStubs is a list: ${JSON.stringify(listed)}`);
    return listed
        .map((name: unknown) => {
            assert.equal(
                typeof name,
                "string",
                `an active stub is named by text: ${JSON.stringify(listed)}`,
            );
            return String(name);
        })
        .sort();
}

// One stubbed answer a result records: which stub answered a request, and with which of its
// responses. Read from the result as plain JSON, wherever the result keeps it.
type StubbedAnswer = { readonly stub: string; readonly responseIndex: number };

// Every record of a stubbed answer in the result, in the order the result's JSON holds them: any
// object with a stub name (under "stub" or "stubbed") and a numeric "responseIndex".
export function stubbedAnswersIn(result: RunResult): readonly StubbedAnswer[] {
    const found: StubbedAnswer[] = [];
    const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item);
            }
            return;
        }
        if (typeof value !== "object" || value === null) {
            return;
        }
        const fields: Readonly<Record<string, unknown>> = { ...value };
        const stub = typeof fields["stub"] === "string" ? fields["stub"] : fields["stubbed"];
        const responseIndex = fields["responseIndex"];
        if (typeof stub === "string" && typeof responseIndex === "number") {
            found.push({ stub, responseIndex });
        }
        for (const nested of Object.values(fields)) {
            visit(nested);
        }
    };
    visit(JSON.parse(JSON.stringify(result)));
    return found;
}

// Values made fresh for one harness: personal data the account page and /api/profile hold.
// Neither begins with a step type, a field or a header name, so a leak scan's prefix check can
// only match the value itself.
type Canaries = { readonly profileName: string; readonly profileEmail: string };

const json = (body: unknown, status = 200): FixtureResponse => ({
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
});
const fileAs = (name: string, mediaType: string): FixtureRoute => {
    const bytes = readFileSync(join(FIXTURE_FOLDER, name));
    return () => ({ headers: { "content-type": mediaType }, body: bytes });
};

// The server's own files under /api/assets/, by the path a page asks for.
export const SERVER_ASSETS: Readonly<Record<string, readonly [string, string]>> = {
    "/api/assets/widget.js": ["asset-widget.js", "text/javascript"],
    "/api/assets/theme.css": ["asset-theme.css", "text/css"],
    "/api/assets/frame.html": ["asset-frame.html", "text/html; charset=utf-8"],
    "/api/assets/frame-message.js": ["asset-frame-message.js", "text/javascript"],
    "/api/assets/worker.js": ["asset-worker.js", "text/javascript"],
    "/api/assets/pixel.svg": ["asset-pixel.svg", "image/svg+xml"],
    "/api/assets/page.html": ["asset-page.html", "text/html; charset=utf-8"],
};

const itemsBody = (names: readonly string[]) => ({
    source: "server",
    items: names.map((name) => ({ name })),
    total: names.length,
});

const itemsRoute: FixtureRoute = (request) => {
    if (request.query.get("page") === "2") {
        return json(itemsBody([NEXT_PAGE_FIRST_ITEM, "Sieve"]));
    }
    if (request.query.get("slow") !== "1") {
        return json(itemsBody(ITEM_NAMES));
    }
    // Answered in two halves 600 ms apart, so the request stays in flight.
    const body = Buffer.from(JSON.stringify(itemsBody(ITEM_NAMES)), "utf8");
    const half = Math.floor(body.length / 2);
    return {
        headers: { "content-type": "application/json" },
        chunks: [body.subarray(0, half), body.subarray(half)],
        chunkPauseMilliseconds: 600,
    };
};

function routesFor(canaries: Canaries): ReadonlyMap<string, FixtureRoute> {
    const routes = new Map<string, FixtureRoute>();
    const bigItems = Array.from(
        { length: 200 },
        (_unused, index) => `Archived kettle number ${index}`,
    );
    routes.set("/api/schedule", () => json({ source: "server", day: "Friday" }));
    routes.set("/api/sequence", () => json({ source: "server", answer: "server" }));
    routes.set("/api/items", itemsRoute);
    routes.set("/api/items-archive", () => json(itemsBody([])));
    routes.set("/api/big-items", () => json(itemsBody(bigItems)));
    routes.set("/api/plain-items", () => ({
        headers: { "content-type": "text/plain" },
        body: "Kettle, Toaster",
    }));
    routes.set("/api/missing-items", () => json({ source: "server", code: "not-found" }, 404));
    routes.set("/api/notes", () =>
        json({ source: "server", note: "Plain notes from the server", items: [] }),
    );
    // The stub fixture's own bytes served as an HTML page, where its script markup does run.
    routes.set("/notes-as-page.html", fileAs(MARKUP_FIXTURE, "text/html; charset=utf-8"));
    for (const [path, [file, mediaType]] of Object.entries(SERVER_ASSETS)) {
        routes.set(path, fileAs(file, mediaType));
    }
    routes.set("/api/assets/data.json", () => json({ source: "server" }));
    routes.set("/api/worker-items", () =>
        json({ source: "server", items: [{ name: "Server kettle" }] }),
    );
    routes.set("/api/stubbed-data", () => json({ source: "server" }));
    routes.set("/api/real-data", () => json({ source: "server" }));
    routes.set("/api/profile", () => json({ source: "server", email: canaries.profileEmail }));
    routes.set("/api/token", () => json({ source: "server", token: "server-token" }));
    const accountTemplate = readFileSync(join(FIXTURE_FOLDER, "account.html"), "utf8");
    routes.set("/account.html", () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: accountTemplate.replace("PROFILE_NAME", canaries.profileName),
    }));
    return routes;
}

export type NetworkRun = BrowserRun & {
    // The paths the second fixture server was asked for during the run.
    readonly otherRequestedPaths: readonly string[];
};

type NetworkHarnessOptions = {
    // Origins the project allows besides the two fixture origins, such as one only a proxy blocks.
    readonly extraOrigins?: readonly string[];
};

export type NetworkHarness = Omit<BrowserHarness, "run" | "runSteps" | "close"> & {
    readonly otherServer: FixtureServer;
    readonly otherOrigin: string;
    readonly canaries: Canaries;
    run(plan: Plan, targetId: string, options?: BrowserRunOptions): Promise<NetworkRun>;
    // networkPlan, parsed and run on the target.
    runSteps(
        targetId: string,
        steps: readonly unknown[],
        options?: BrowserRunOptions & { readonly fields?: JsonRecord },
    ): Promise<NetworkRun>;
    otherUrl(path: string): string;
    close(): Promise<void>;
};

export async function networkHarness(options: NetworkHarnessOptions = {}): Promise<NetworkHarness> {
    const nonce = letterNonce(10);
    const canaries: Canaries = {
        profileName: `Zqvoth${nonce} Ellery`,
        profileEmail: `zqmail${nonce}.holder@example.test`,
    };
    const routes = routesFor(canaries);
    const otherRequested: string[] = [];
    const otherServer = await startFixtureServer(
        FIXTURE_FOLDER,
        (path) => {
            otherRequested.push(path);
        },
        routes,
    );
    const harness = await startBrowserHarness({
        fixtureFolder: FIXTURE_FOLDER,
        routes,
        projectFile: (origin) =>
            networkProjectFile(origin, otherServer.origin, options.extraOrigins),
        seed: SEED,
        fixedTimeMilliseconds: CLOCK_START_MILLISECONDS,
        drivers: networkDrivers(),
        planFor: networkPlan,
        readAtClose: ["input-events"],
    });
    const run = async (
        plan: Plan,
        targetId: string,
        runOptions: BrowserRunOptions = {},
    ): Promise<NetworkRun> => {
        const firstOtherRequest = otherRequested.length;
        const ran = await harness.run(plan, targetId, runOptions);
        return { ...ran, otherRequestedPaths: otherRequested.slice(firstOtherRequest) };
    };
    return {
        ...harness,
        otherServer,
        otherOrigin: otherServer.origin,
        canaries,
        run,
        runSteps: (targetId, steps, runOptions = {}) =>
            run(
                harness.plan(networkPlan(targetId, steps, runOptions.fields ?? {})),
                targetId,
                runOptions,
            ),
        otherUrl: (path) => `${otherServer.origin}${path}`,
        close: async () => {
            await harness.close();
            await otherServer.close();
        },
    };
}

// How many times the paths list holds `path`.
export const timesRequested = (paths: readonly string[], path: string): number =>
    paths.filter((requestedPath) => requestedPath === path).length;
