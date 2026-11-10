// The ports of the draft and suite commands come from the composition root, so what keeps a run honest
// is there without being asked for: the real redactor and a browser that is either the host's or says
// it is absent. Weakening either takes an explicit override, in plain sight.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { buildAdapters } from "@revisum/cli";
import { type Redactor } from "@revisum/engine";
import { fakeDriver } from "#test-support/fakes/session/FakeDriver.ts";
import { fakeEventSink } from "#test-support/fakes/ports/FakeEventSink.ts";
import { fakeSecretStore } from "#test-support/fakes/ports/FakeSecretStore.ts";
import { fakeVersionControlPort } from "#test-support/fakes/ports/FakeVersionControlPort.ts";
import { fakeWorkloadRunner } from "#test-support/fakes/services/FakeWorkloadRunner.ts";
import { projectWith, targetInput } from "../../engine/target/examples/TargetOf.ts";
import { PINNED_IMAGE_ID, imageDigest } from "../../runner/examples/DeclaredService.ts";
import { buildEgressPolicy } from "@revisum/runner";

const EMAIL_ADDRESS = "grace.hopper@example.org";
const NOT_LAUNCHED = "never-launched";
const MATRIX = [targetInput("chromium-desktop", "fake-any", "chromium", "desktop-1280")];

const DOING_NOTHING: Redactor = { selectors: [], text: (value) => value };

const draftNeeds = () => {
    const secrets = fakeSecretStore();
    return {
        workingDirectory: "project",
        secrets,
        events: fakeEventSink(),
        versionControl: fakeVersionControlPort(),
        planner: buildAdapters.plannerCalls({ secrets }),
    };
};

const suiteNeeds = () =>
    ({
        workload: fakeWorkloadRunner(),
        secrets: fakeSecretStore(),
        checkout: "checkout",
        outputDirectory: "output",
        pass: "gating",
    }) as const;

const theTarget = () => {
    const [target] = projectWith(MATRIX).matrix;
    assert.ok(target !== undefined, "the project has no target");
    return target;
};

describe("Using the draft command's ports", () => {
    describe("given no redactor among the overrides", () => {
        describe("when the ports are built", () => {
            test("then it should supply the real redactor", () => {
                const { redactor } = buildAdapters.draftCommandPorts(draftNeeds());
                assert.ok(!redactor.text(EMAIL_ADDRESS).includes(EMAIL_ADDRESS));
            });
        });
    });

    describe("given a redactor as an explicit override", () => {
        describe("when the ports are built", () => {
            test("then it should use that one", () => {
                const { redactor } = buildAdapters.draftCommandPorts(draftNeeds(), {
                    redactor: DOING_NOTHING,
                });
                assert.equal(redactor, DOING_NOTHING);
            });
        });
    });

    describe("given a browser as an explicit override", () => {
        describe("when the ports are built", () => {
            test("then it should use that one", () => {
                const browser = fakeDriver();
                const ports = buildAdapters.draftCommandPorts(draftNeeds(), { browser });
                assert.equal(ports.browser, browser);
            });
        });
    });

    describe("given the path of a browser", () => {
        describe("when the ports are built", () => {
            test("then it should supply a host browser that can drive the target", () => {
                const ports = buildAdapters.draftCommandPorts({
                    ...draftNeeds(),
                    executablePath: NOT_LAUNCHED,
                });
                assert.ok(ports.browser.supports(theTarget()).ok);
            });
        });
    });

    describe("given no path of a browser", () => {
        describe("when the ports are built", () => {
            test("then it should supply a browser that says it cannot drive the target", () => {
                const ports = buildAdapters.draftCommandPorts(draftNeeds());
                assert.equal(ports.browser.supports(theTarget()).ok, false);
            });
        });
    });

    describe("given no isolated runner among the overrides", () => {
        describe("when a run is asked of the isolated runner", () => {
            test("then it should refuse, having started nothing", async (context) => {
                const { isolatedRunner } = buildAdapters.draftCommandPorts(draftNeeds());
                const policy = buildEgressPolicy({ allowOrigins: [], allowServices: [] });
                assert.ok(policy.ok, JSON.stringify(policy));
                const use = context.mock.fn(() => Promise.resolve(undefined));
                const started = await isolatedRunner.runner.withRun(
                    imageDigest(PINNED_IMAGE_ID),
                    policy.value,
                    use,
                );
                assert.equal(started.ok, false);
                assert.equal(use.mock.callCount(), 0);
            });
        });
    });
});

describe("Using a suite run's ports", () => {
    describe("given no redactor among the overrides", () => {
        describe("when the ports are built", () => {
            test("then it should supply the real redactor", () => {
                const { redactor } = buildAdapters.suiteRunPorts(suiteNeeds());
                assert.ok(!redactor.text(EMAIL_ADDRESS).includes(EMAIL_ADDRESS));
            });
        });
    });

    describe("given a redactor as an explicit override", () => {
        describe("when the ports are built", () => {
            test("then it should use that one", () => {
                const { redactor } = buildAdapters.suiteRunPorts(suiteNeeds(), {
                    redactor: DOING_NOTHING,
                });
                assert.equal(redactor, DOING_NOTHING);
            });
        });
    });
});
