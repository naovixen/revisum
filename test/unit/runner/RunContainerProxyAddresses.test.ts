// An isolated run's container holds both a browser and whatever calls services, and the one proxy can
// only tell them apart by where each one connects: their requests look alike, and a page could forge
// anything in one. So the two get an address each, and the one a browser takes by default is the one
// that closes the socket on a refusal. Wrongly used, that gives a service a failed call, never a page
// a readable answer. What each address does on real Docker is in the container tests.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { ContainerOptions } from "@revisum/runner";
import { dockerRunner } from "@revisum/runner";
import { REPOSITORY_ROOT } from "../../support/repository.ts";
import { fakeContainerEngine } from "./fake-container-engine.ts";
import { egressPolicy, imageDigest, PINNED_IMAGE_ID } from "./runner-examples.ts";

const POLICY = egressPolicy({ allowOrigins: ["http://app.test"] });
const BROWSER_PROXY_PORT = "3128";

const addressIn = (container: ContainerOptions, variable: string): URL => {
    const value = container.environment[variable];
    assert.ok(value !== undefined, `the run container has no ${variable}`);
    return new URL(value);
};

describe("Using the isolated runner", () => {
    describe("given a run on a host that enforces egress", () => {
        describe("when its containers start", () => {
            let runContainer: ContainerOptions;
            let proxyContainer: ContainerOptions;
            before(async () => {
                const engine = fakeContainerEngine({
                    localImageId: PINNED_IMAGE_ID,
                    internalNetworks: true,
                    probe: "blocked",
                });
                const started = await dockerRunner({
                    engine,
                    repositoryRoot: REPOSITORY_ROOT,
                }).withRun(imageDigest(PINNED_IMAGE_ID), POLICY, () => Promise.resolve());
                assert.ok(started.ok, JSON.stringify(started));
                const named = (ending: string): ContainerOptions => {
                    const found = engine.started.find((each) => each.name.endsWith(ending));
                    assert.ok(found !== undefined, `no container named ...${ending}`);
                    return found;
                };
                runContainer = named("-run");
                proxyContainer = named("-proxy");
            });

            test("then it should point a browser at the proxy's own port", () => {
                const address = addressIn(runContainer, "HTTP_PROXY");
                assert.equal(address.hostname, proxyContainer.name);
                assert.equal(address.port, BROWSER_PROXY_PORT);
            });

            test("then it should give service calls another port on the same proxy", () => {
                const address = addressIn(runContainer, "SERVICE_PROXY");
                assert.equal(address.hostname, proxyContainer.name);
                assert.notEqual(address.port, BROWSER_PROXY_PORT);
            });
        });
    });
});
