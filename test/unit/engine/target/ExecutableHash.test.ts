// When core launches a browser, it hashes the executable it launches and records that hash in the
// manifest, rather than trusting the version the adapter reports. It hashes whenever the adapter has
// a build port, with or without a lockfile, before the browser opens; an executable it cannot hash
// is never launched. The browser's version stays a label.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createRunService, planParser, sha256, type RunResult } from "@revisum/engine";
import { baseUrlOf, clearRun, trustedProjectFrom } from "../../../support/builders/ClearRun.ts";
import {
    fixtureReferences,
    parsedProject,
    removeFakeExecutables,
    runScenario,
    scenarioDriver,
    type Scenario,
    closedScenario,
} from "../replay/examples/ManifestUnderTest.ts";
import { OPEN_ORDERS, accepted, planOf, projectFileWith } from "../run/values/examples/RunPlan.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";

after(removeFakeExecutables);

const EXECUTABLE = "chromium executable, build 156.0.8078.47";
const BUILT: Scenario = {
    ...closedScenario(projectFileWith(), planOf([OPEN_ORDERS])),
    executable: EXECUTABLE,
    reportedBuildVersion: "156.0.8078.47",
    browserVersion: "156.0.8078.47",
};

test("a run on an adapter with a build port records the sha256 of the executable, with no lockfile", async () => {
    const ran = await runScenario(BUILT);
    assert.equal(ran.manifest.executableSha256, sha256(EXECUTABLE));
});

test("the executable is hashed before the browser opens", async () => {
    const ran = await runScenario(BUILT);
    const order = ran.driverCalls.order;
    assert.ok(order.includes("build") && order.includes("open"), JSON.stringify(order));
    assert.ok(
        order.indexOf("build") < order.indexOf("open"),
        `the build was asked after the browser opened: ${JSON.stringify(order)}`,
    );
});

test("the reported version is a label: another reported version on the same executable records the same hash", async () => {
    const first = await runScenario(BUILT);
    const relabelled = await runScenario({
        ...BUILT,
        reportedBuildVersion: "157.0.0.1",
        browserVersion: "157.0.0.1",
    });
    assert.equal(relabelled.manifest.executableSha256, sha256(EXECUTABLE));
    assert.equal(relabelled.manifest.executableSha256, first.manifest.executableSha256);
    assert.notDeepEqual(
        relabelled.manifest.browser,
        first.manifest.browser,
        "the browser label follows what the adapter reports",
    );
});

test("counter-example: another executable under the same reported version records another hash", async () => {
    const first = await runScenario(BUILT);
    const swapped = await runScenario({ ...BUILT, executable: `${EXECUTABLE}, swapped in place` });
    assert.equal(swapped.manifest.executableSha256, sha256(`${EXECUTABLE}, swapped in place`));
    assert.notEqual(swapped.manifest.executableSha256, first.manifest.executableSha256);
    assert.deepEqual(
        swapped.manifest.browser,
        first.manifest.browser,
        "the reported version did not change",
    );
});

test("an executable core cannot hash ends the run TargetUnavailable, and the browser never opens", async () => {
    const missing = join(tmpdir(), "revisum-no-such-browser", "browser-executable");
    const { result, calls } = await runKeepingAnyOutcome({ ...BUILT, executablePath: missing });
    assert.equal(result.state, "TargetUnavailable");
    assert.equal(result.manifest, null);
    assert.ok(calls.includes("build"), `the build port was never asked: ${JSON.stringify(calls)}`);
    assert.equal(calls.includes("open"), false, `the browser opened: ${JSON.stringify(calls)}`);
});

test("a run on an adapter with no build port records no executable hash", async () => {
    const ran = await runScenario({ ...BUILT, executable: null });
    assert.equal(
        Object.hasOwn(ran.manifest, "executableSha256"),
        false,
        JSON.stringify(ran.manifest),
    );
});

// The scenario's run, whatever its outcome (runScenario insists on a manifest), with the driver's calls.
async function runKeepingAnyOutcome(
    scenario: Scenario,
): Promise<{ readonly result: RunResult; readonly calls: readonly string[] }> {
    const { driver, calls } = scenarioDriver(scenario);
    const project = parsedProject(scenario.projectFile);
    const plan = accepted(planParser(project), scenario.plan);
    const result = await createRunService(fakePorts({ drivers: driversOf(driver) })).run(
        clearRun(
            plan,
            await trustedProjectFrom(scenario.projectFile),
            project.matrix[0]?.id ?? assert.fail("no target"),
        ),
        {
            baseUrl: baseUrlOf(scenario.baseUrl),
            seed: scenario.seed,
            fixedTimeMilliseconds: scenario.clockStartMilliseconds,
            fixtures: fixtureReferences(scenario.fixtures),
            host: scenario.host,
        },
    );
    return { result, calls: calls.order };
}
