// A run whose egress proxy rewrote a response tested a mutated app, so its manifest must say so: a
// mutated run can never pass for a plain one. Only the proxy knows what it applied, and only once the
// steps have run, so the run reads it from a port after them. A run with no rewrite keeps exactly the
// manifest and hash of a plain one.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    createRunService,
    manifestHash,
    noRewrites,
    planParser,
    success,
    type RunResult,
} from "@revisum/engine";
import { baseUrlOf, clearRun, trustedProjectFrom } from "../../support/policy-clearance.ts";
import { fakeSessionOnOrders } from "./RunOnFakeSession.ts";
import {
    DEFAULT_CLOCK_START,
    DEFAULT_SEED,
    OPEN_ORDERS,
    ORIGIN,
    accepted,
    planOf,
    projectFileWith,
    projectWith,
} from "./run-value-examples.ts";
import { fakeDriverOpening } from "#test-support/fakes/FakeDriver.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";

const HEADING_CHANGED = { origin: ORIGIN, name: "heading-changed" };
const STATUS_FLIPPED = { origin: ORIGIN, name: "status-flipped" };

type RewritesApplied = () => readonly { readonly origin: string; readonly name: string }[];

// Runs one plan with the proxy's port as the run's ports hold it, when the test gives one. `applied`
// says what the proxy has applied once the page has been opened, so a read before the steps sees none.
const runWithRewrites = async (
    applied?: readonly { origin: string; name: string }[],
): Promise<RunResult> => {
    const project = projectWith();
    const plan = accepted(planParser(project), planOf([OPEN_ORDERS]));
    const trusted = await trustedProjectFrom(projectFileWith());
    let isPageOpened = false;
    const session = fakeSessionOnOrders({
        navigate: () => {
            isPageOpened = true;
            return Promise.resolve(success(undefined));
        },
    });
    const driver = fakeDriverOpening(session);
    const rewritesApplied: RewritesApplied =
        applied === undefined ? noRewrites : () => (isPageOpened ? applied : []);
    const ports = fakePorts({ drivers: driversOf(driver), rewritesApplied });
    return createRunService(ports).run(
        clearRun(plan, trusted, project.matrix[0]?.id ?? assert.fail("no target")),
        {
            baseUrl: baseUrlOf(ORIGIN),
            seed: DEFAULT_SEED,
            fixedTimeMilliseconds: DEFAULT_CLOCK_START,
            fixtures: [],
            host: { platform: "test", arch: "test" },
        },
    );
};

const manifestOf = (result: RunResult) =>
    result.manifest ?? assert.fail("the run made no manifest");

describe("Using a run", () => {
    describe("given an egress proxy that applied a response rewrite during the steps", () => {
        describe("when the run ends", () => {
            test("then it should record the rewrite in its manifest by origin and name", async () => {
                const mutated = await runWithRewrites([HEADING_CHANGED]);
                assert.deepEqual(manifestOf(mutated).responseRewrites, [HEADING_CHANGED]);
            });

            test("then it should give a manifest hash of its own manifest, unlike a plain run's", async () => {
                const plain = await runWithRewrites();
                const mutated = await runWithRewrites([HEADING_CHANGED]);
                assert.notEqual(mutated.manifestHash, plain.manifestHash);
                assert.equal(mutated.manifestHash, manifestHash(manifestOf(mutated)));
            });

            test("then it should give a result hash unlike a plain run's", async () => {
                const plain = await runWithRewrites();
                const mutated = await runWithRewrites([HEADING_CHANGED]);
                assert.notEqual(mutated.resultHash, plain.resultHash);
            });
        });
    });

    describe("given an egress proxy that applied two rewrites, in either order", () => {
        describe("when the run ends", () => {
            test("then it should list them the same way in its manifest", async () => {
                const one = await runWithRewrites([STATUS_FLIPPED, HEADING_CHANGED]);
                const other = await runWithRewrites([HEADING_CHANGED, STATUS_FLIPPED]);
                assert.deepEqual(manifestOf(one).responseRewrites, [
                    HEADING_CHANGED,
                    STATUS_FLIPPED,
                ]);
                assert.equal(one.manifestHash, other.manifestHash);
            });
        });
    });

    describe("given an egress proxy that applied no rewrite", () => {
        describe("when the run ends", () => {
            test("then it should keep a plain run's manifest and hash exactly", async () => {
                const plain = await runWithRewrites();
                const none = await runWithRewrites([]);
                assert.ok(!Object.hasOwn(manifestOf(none), "responseRewrites"));
                assert.equal(none.manifestHash, plain.manifestHash);
                assert.equal(none.resultHash, plain.resultHash);
            });
        });
    });
});
