// Shared setup for the browser tests of the plan language's driver parts: the plan clock,
// remembered values, positions, declared test-id attributes, key chords and multi-line fills.
//
// It serves the plan-values fixture app (test/fixtures/sites/plan-values-app/). The project's targets are the
// own CDP driver on Chrome for Testing and on its headless shell. It declares three test-id
// attributes: data-testid, data-qa and id.
//
// Every run reads the page just before the run closes its session: the page's URL and the texts
// of chosen test ids, such as the input-event counter every fixture page keeps (counting.js), so
// a test can show what a failed or refused step did not send.
import { join } from "node:path";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/driver/CreateBrowserDriver.ts";
import { rawPlan, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";

const SEED = 23;
// The run's own clock start: 28 October 2026, 12:00 UTC.
export const CLOCK_START_MILLISECONDS = Date.UTC(2026, 9, 28, 12, 0, 0);
const STEP_TIMEOUT_MILLISECONDS = 2000;

const TEST_ID_ATTRIBUTES = ["data-testid", "data-qa", "id"] as const;

const planValuesProjectFile = (origin: string) => ({
    origins: [origin],
    limits: { stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS },
    testIdAttributes: [...TEST_ID_ATTRIBUTES],
    matrix: englishMatrix(Object.values(BrowserTarget)),
});

export const planFor = (
    targetId: string,
    steps: readonly unknown[],
    fields: JsonRecord = {},
): JsonRecord =>
    rawPlan(
        {
            featureId: "VALUES-1",
            specReference: "specs/plan-values.md#driver",
            title: "Plan values in a browser",
        },
        targetId,
        steps,
        fields,
    );

export const planValuesHarness = (
    routes: ReadonlyMap<string, FixtureRoute> = new Map(),
): Promise<BrowserHarness> =>
    startBrowserHarness({
        fixtureFolder: join(FIXTURES, "sites", "plan-values-app"),
        routes,
        projectFile: planValuesProjectFile,
        seed: SEED,
        fixedTimeMilliseconds: CLOCK_START_MILLISECONDS,
        drivers: driversForTargets(Object.values(BrowserTarget)),
        planFor,
        readAtClose: ["input-events"],
    });
