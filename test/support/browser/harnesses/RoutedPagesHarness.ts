// A real browser on pages a test writes itself, for bugs that live in how a browser behaves: a port
// nothing listens on, a server that holds its answer back, a page that opens a popup. No page is
// read at close, so a test may kill the browser.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/driver/CreateBrowserDriver.ts";
import { rawPlan, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";

const SEED = 85;
const CLOCK_START_MILLISECONDS = Date.UTC(2026, 10, 2, 12, 0, 0);
const STEP_TIMEOUT_MILLISECONDS = 4000;
// Longer than a page's gap between two requests, so a wait for quiet sees the second.
const QUIET_MILLISECONDS = 500;

export const TARGET = BrowserTarget.Chrome;

export const htmlPage =
    (body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><main>${body}</main></body></html>`,
    });

export const jsonRoute =
    (body: unknown, status = 200): FixtureRoute =>
    () => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// An origin whose port nothing listens on, so a connection to it is refused.
export async function closedOrigin(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return `http://127.0.0.1:${port}`;
}

export type HeldAnswerServer = { readonly origin: string; close(): Promise<void> };

// Answers /api/answer?status=&id=&holdMilliseconds= with that status and {"id":id}, sending nothing
// at all until the hold is over, so the request stays in flight. Any page may ask it.
export async function startHeldAnswerServer(): Promise<HeldAnswerServer> {
    const server = createServer((request, response) => {
        const query = new URL(request.url ?? "/", "http://localhost").searchParams;
        setTimeout(
            () => {
                response.writeHead(Number(query.get("status") ?? 200), {
                    "content-type": "application/json",
                    "access-control-allow-origin": "*",
                    "cache-control": "no-store",
                });
                response.end(JSON.stringify({ id: query.get("id") ?? "" }));
            },
            Number(query.get("holdMilliseconds") ?? 0),
        );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        close: () =>
            new Promise((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

export const requestMatcher = (origin: string, path: string): JsonRecord => ({
    origin,
    method: "GET",
    path,
    match: "exact",
});

export type RoutedPages = {
    readonly routes: ReadonlyMap<string, FixtureRoute>;
    // Origins the project allows beside the pages' own.
    readonly otherOrigins?: readonly string[];
    readonly observedRequests?: (origin: string) => JsonRecord;
    readonly unsafeFeatures?: JsonRecord;
    readonly stepTimeoutMilliseconds?: number;
};

const routedPagesPlan = (
    targetId: string,
    steps: readonly unknown[],
    fields: JsonRecord = {},
): JsonRecord =>
    rawPlan(
        { featureId: "PAGES-1", specReference: "specs/pages.md#browser", title: "Routed pages" },
        targetId,
        steps,
        fields,
    );

export function routedPagesHarness(pages: RoutedPages): Promise<BrowserHarness> {
    return startBrowserHarness({
        fixtureFolder: join(FIXTURES, "sites", "capability-app"),
        routes: pages.routes,
        projectFile: (origin) => ({
            origins: [origin, ...(pages.otherOrigins ?? [])],
            limits: {
                stepTimeoutMilliseconds: pages.stepTimeoutMilliseconds ?? STEP_TIMEOUT_MILLISECONDS,
                requestQuietMilliseconds: QUIET_MILLISECONDS,
            },
            observedRequests: pages.observedRequests?.(origin) ?? {},
            ...(pages.unsafeFeatures === undefined ? {} : { unsafeFeatures: pages.unsafeFeatures }),
            matrix: englishMatrix([TARGET]),
        }),
        seed: SEED,
        fixedTimeMilliseconds: CLOCK_START_MILLISECONDS,
        drivers: driversForTargets([TARGET]),
        planFor: routedPagesPlan,
    });
}
