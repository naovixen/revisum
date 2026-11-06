// Runs inside the run container, started through RunnerHandle.exec, as well as being what a test
// outside imports to start it. It runs one plan through the driver a container's run uses, on a page
// on the container's own loopback whose shared worker asks for undeclared origins. A shared worker's
// requests are seen only by the proxy, so what it hears is what the proxy told it, and the run's list
// of blocked origins can only hold them if the proxy's refusals reach the run.
import assert from "node:assert/strict";
import { arch, platform } from "node:os";
import { join } from "node:path";
import type { RunnerHandle } from "@revisum/contracts";
import { parseProject, planParser, run, type RunResult } from "@revisum/engine";
import { navigate, rawPlan, testId, textEquals } from "../support/browser/RawPlan.ts";
import { BROWSERS } from "../support/browsers.ts";
import {
    startFixtureServer,
    type FixtureRoute,
    type FixtureServer,
} from "../support/fixture-server.ts";
import { systemClock } from "../support/memory-ports.ts";
import { baseUrlOf, clearRun, trustedProjectFrom } from "../support/policy-clearance.ts";
import { FIXTURES } from "../support/repository.ts";
import { buildAdapters } from "../../packages/cli/src/BuildAdapters.ts";
import { realRunPorts } from "../support/RealRunPorts.ts";

const THIS_FILE_IN_THE_WORKSPACE = "test/containers/RunBrowserPastRefusalsInside.ts";
const PAGE_PATH = "/refusals.html";
const WORKER_PATH = "/asks-for-undeclared-origins.js";
const WORKER_ANSWER = "worker-answer";
const TARGET_ID = "cdp-chromium";
const SEED = 7;
const FIXED_TIME_MILLISECONDS = Date.UTC(2026, 9, 29, 12, 0, 0);

export const WHAT_A_CLOSED_SOCKET_LOOKS_LIKE = "network error";
export const REFUSED_PLAIN_ORIGIN = "http://refused-plain.invalid";
export const REFUSED_SECURE_HOST = "refused-secure.invalid";
// Asked for by the page and by the worker, so the driver and the proxy each refuse it in their form.
export const REFUSED_BY_BOTH_HOST = "refused-by-both.invalid";

// With no-cors, an answer of any status resolves and a closed socket rejects, so the worker can tell
// them apart whatever the answer's headers say.
const WORKER_SCRIPT = `
  const askedFor = (url) => fetch(url, { mode: 'no-cors' }).then(() => 'answered', () => '${WHAT_A_CLOSED_SOCKET_LOOKS_LIKE}');
  onconnect = async ({ ports: [port] }) => {
    const [plain] = await Promise.all([
      askedFor('${REFUSED_PLAIN_ORIGIN}/data'),
      askedFor('https://${REFUSED_SECURE_HOST}/data'),
      askedFor('https://${REFUSED_BY_BOTH_HOST}/data'),
    ]);
    port.postMessage(plain);
  };`;

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Refusals</title></head><body>
  <img alt="" src="https://${REFUSED_BY_BOTH_HOST}/picture.png">
  <p data-testid="${WORKER_ANSWER}">waiting</p>
  <script>
    const worker = new SharedWorker('${WORKER_PATH}');
    worker.port.onmessage = ({ data }) => {
      document.querySelector('[data-testid="${WORKER_ANSWER}"]').textContent = data;
    };
  </script>
</body></html>`;

export type RunPastRefusals = {
    readonly state: string;
    readonly blockedOrigins: readonly string[];
    readonly observedOnFailure: readonly (string | undefined)[];
};

const textRoute =
    (mediaType: string, body: string): FixtureRoute =>
    () => ({
        headers: { "content-type": `${mediaType}; charset=utf-8` },
        body,
    });

const projectFileFor = (origin: string) => ({
    origins: [origin],
    limits: { stepTimeoutMilliseconds: 10_000 },
    matrix: [
        {
            id: TARGET_ID,
            adapter: "cdp",
            engine: "chromium",
            device: "desktop-1280",
            locale: "en-GB",
            timezone: "Europe/London",
            colorScheme: "light",
            reducedMotion: "reduce",
        },
    ],
});

const PLAN = rawPlan(
    {
        featureId: "ISOLATION-1",
        specReference: "specs/isolation.md#refusals",
        title: "A worker asks for undeclared origins",
    },
    TARGET_ID,
    [
        navigate(PAGE_PATH),
        textEquals(
            testId(WORKER_ANSWER),
            WHAT_A_CLOSED_SOCKET_LOOKS_LIKE,
            "isolation.refusal-unreadable",
        ),
    ],
);

async function runPlanAgainst(fixture: FixtureServer, proxyServer: string): Promise<RunResult> {
    const projectFile = projectFileFor(fixture.origin);
    const project = parseProject(projectFile);
    assert.ok(project.ok, "the project parses");
    const parsedPlan = planParser(project.value)(PLAN);
    assert.ok(parsedPlan.ok, "the plan parses");
    const target = project.value.matrix[0];
    assert.ok(target !== undefined, "the project has a target");
    return run(
        clearRun(parsedPlan.value, await trustedProjectFrom(projectFile), target.id),
        {
            baseUrl: baseUrlOf(fixture.origin),
            seed: SEED,
            fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
            fixtures: fixture.fixtures,
            host: { platform: platform(), arch: arch() },
        },
        realRunPorts({
            drivers: new Map([
                [
                    "cdp",
                    buildAdapters.containerBrowserDriver({
                        executablePath: BROWSERS.chrome,
                        proxyServer,
                    }),
                ],
            ]),
            clock: systemClock,
        }),
    );
}

async function runInThisContainer(): Promise<RunPastRefusals> {
    const proxyServer = process.env["HTTP_PROXY"];
    assert.ok(proxyServer !== undefined && proxyServer !== "", "the run container has a proxy");
    const fixture = await startFixtureServer(
        join(FIXTURES, "egress-app"),
        undefined,
        new Map([
            [PAGE_PATH, textRoute("text/html", PAGE)],
            [WORKER_PATH, textRoute("text/javascript", WORKER_SCRIPT)],
        ]),
    );
    try {
        const result = await runPlanAgainst(fixture, proxyServer);
        return {
            state: result.state,
            blockedOrigins: result.blockedOrigins,
            observedOnFailure: result.steps
                .filter((step) => step.outcome !== "passed")
                .map((step) => step.observed),
        };
    } finally {
        await fixture.close();
    }
}

// Starts the plan inside the run container and answers with what it printed.
export async function runBrowserPastRefusalsInside(handle: RunnerHandle): Promise<RunPastRefusals> {
    const outcome = await handle.exec(["node", THIS_FILE_IN_THE_WORKSPACE]);
    assert.equal(outcome.exitCode, 0, `the plan inside the container failed: ${outcome.stderr}`);
    return JSON.parse(outcome.stdout.trim().split("\n").at(-1) ?? "null") as RunPastRefusals;
}

if (import.meta.main) {
    console.log(JSON.stringify(await runInThisContainer()));
}
