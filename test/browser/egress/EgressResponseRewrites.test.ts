// Browser mutants: the egress proxy rewrites plain-HTTP responses from declared fixture origins,
// and only from them, and reports each rewrite it applied so the run manifest records it.
//
// Two copies of the same fixture page are served on two declared origins; only the first is a
// fixture origin with a rewrite. A real headless Chromium, through the own CDP driver, loads both
// through the in-process proxy: the first shows the mutated heading, the second, the
// counter-example, still shows the original. A plan run on the same proxy then shows the rewrite
// reaching the run's manifest.
import assert from "node:assert/strict";
import { arch, platform } from "node:os";
import { after, before, test } from "node:test";
import type { DriverSession } from "@revisum/driver-cdp";
import { createBrowserDriver } from "#test-support/browser/driver/CreateBrowserDriver.ts";
import { egressThrough } from "#test-support/browser/driver/SessionEgressForTest.ts";
import {
    createRunService,
    defaultRedactor,
    parseProject,
    planParser,
    type SessionEnvironment,
} from "@revisum/engine";
import { type EgressProxy, type ResponseRewrite } from "@revisum/runner";
import { startedEgressProxy } from "#test-support/StartedEgressProxy.ts";
import { BROWSERS } from "#test-support/browser/Browsers.ts";
import { createCleanUpScope } from "#test-support/CleanUpScope.ts";
import {
    ADAPTER_OF_TARGET,
    BrowserTarget,
    englishMatrix,
} from "#test-support/browser/BrowserTarget.ts";
import {
    FIXED_TIME_MILLISECONDS,
    SEED,
    capabilityHarness,
    capabilityPlan,
    type CapabilityHarness,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import { navigate, testId } from "#test-support/browser/RawPlan.ts";
import { systemClock } from "#test-support/builders/MemoryEventSink.ts";
import { realRunPorts } from "#test-support/RealRunPorts.ts";
import {
    startEgressFixtureServer,
    type EgressFixtureServer,
} from "../../unit/runner/support/EgressFixtureServer.ts";
import {
    declaredService,
    egressPolicy,
    fakeResolver,
    origin,
} from "../../unit/runner/examples/DeclaredService.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { baseUrlOf, clearRun, trustedProjectFrom } from "#test-support/builders/ClearRun.ts";

const HEADING_CHANGED: ResponseRewrite = {
    name: "heading-changed",
    find: "Original heading",
    replace: "Mutated heading",
};
const readHeading = (): string =>
    document.querySelector('[data-testid="heading"]')?.textContent ?? "";

const cleanUps = createCleanUpScope();
let capability: CapabilityHarness;
let fixtureApp: EgressFixtureServer;
let secondApp: EgressFixtureServer;
let proxy: EgressProxy;
let session: DriverSession;

before(async () => {
    capability = await capabilityHarness(5000);
    cleanUps.add(() => capability.close());
    fixtureApp = await startEgressFixtureServer();
    cleanUps.add(() => fixtureApp.close());
    secondApp = await startEgressFixtureServer();
    cleanUps.add(() => secondApp.close());
    proxy = await startedEgressProxy({
        policy: egressPolicy({
            allowOrigins: [fixtureApp.origin, secondApp.origin],
            allowServices: ["fixture-app", "second-app"],
            fixtureOrigins: [fixtureApp.origin],
            responseRewrites: [{ origin: fixtureApp.origin, rewrite: HEADING_CHANGED }],
        }),
        // Both apps listen on loopback, so both are declared as private services.
        services: [
            declaredService("fixture-app", fixtureApp.origin, true),
            declaredService("second-app", secondApp.origin, true),
        ],
        resolve: fakeResolver({}).resolve,
    });
    cleanUps.add(() => proxy.close());
    const environment: SessionEnvironment = {
        baseUrl: baseUrlOf(fixtureApp.origin),
        allowedOrigins: [fixtureApp.origin, secondApp.origin],
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        sensitiveSelectors: defaultRedactor().selectors,
        timeoutMilliseconds: 5000,
    };
    const driver = createBrowserDriver({
        executablePath: BROWSERS.chrome,
        egress: egressThrough(proxy),
    });
    const opened = await driver.open(capability.target(BrowserTarget.Chrome), environment);
    assert.ok(opened.ok, `the session opens: ${opened.ok ? "" : JSON.stringify(opened.error)}`);
    session = opened.value;
    cleanUps.add(() => session.close());
});
after(() => cleanUps.runAll());

test("counter-example: the same page on a declared origin that is not a fixture origin is not rewritten", async () => {
    const navigated = await session.navigate(secondApp.url("/mutant.html"), scriptsEnabled);
    assert.ok(navigated.ok, JSON.stringify(navigated));
    assert.equal(await session.evaluate(readHeading), "Original heading");
    assert.deepEqual(proxy.rewritesApplied(), [], "no rewrite has been applied yet");
});

test("the page on the fixture origin is rewritten by its browser mutant", async () => {
    const navigated = await session.navigate(fixtureApp.url("/mutant.html"), scriptsEnabled);
    assert.ok(navigated.ok, JSON.stringify(navigated));
    assert.equal(await session.evaluate(readHeading), "Mutated heading");
});

test("the proxy reports the rewrite it applied, by origin and name, once", async () => {
    // Loading the fixture page again applies the same rewrite again; it is still one rewrite.
    assert.ok((await session.navigate(fixtureApp.url("/mutant.html"), scriptsEnabled)).ok);
    assert.deepEqual(proxy.rewritesApplied(), [
        { origin: origin(fixtureApp.origin), name: "heading-changed" },
    ]);
});

test("the run manifest records the rewrites the proxy applied", async () => {
    const projectFile = {
        origins: [fixtureApp.origin, secondApp.origin],
        limits: { stepTimeoutMilliseconds: 5000 },
        matrix: englishMatrix([BrowserTarget.Chrome]),
    };
    const project = parseProject(projectFile);
    assert.ok(project.ok, JSON.stringify(project));
    const plan = planParser(project.value)(
        capabilityPlan(BrowserTarget.Chrome, [
            navigate("/mutant.html"),
            {
                type: "expect",
                locator: testId("heading"),
                assert: { kind: "textEquals", value: "Mutated heading" },
                criterionId: "mutant.heading-changed",
            },
        ]),
    );
    assert.ok(plan.ok, JSON.stringify(plan));
    const targetId = project.value.matrix[0]?.id ?? assert.fail("the project has no target");
    const driver = createBrowserDriver({
        executablePath: BROWSERS.chrome,
        egress: egressThrough(proxy),
    });
    const result = await createRunService(
        realRunPorts({
            drivers: new Map([[ADAPTER_OF_TARGET[BrowserTarget.Chrome], driver]]),
            clock: systemClock,
            rewritesApplied: () => proxy.rewritesApplied(),
        }),
    ).run(clearRun(plan.value, await trustedProjectFrom(projectFile), targetId), {
        baseUrl: baseUrlOf(fixtureApp.origin),
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        fixtures: fixtureApp.fixtures,
        host: { platform: platform(), arch: arch() },
    });
    assert.equal(result.state, "Passed", JSON.stringify(result));
    assert.deepEqual(result.manifest.responseRewrites, [
        { origin: fixtureApp.origin, name: "heading-changed" },
    ]);
});
