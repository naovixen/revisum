// A backend check polls, so what it calls must be a read. The parser refuses a write there, but a plan
// parsed under another project reaches the run all the same. A write is never sent by a check, so the
// run refuses it before the first request, and which code it reports is left to the code.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    planParser,
    run,
    type Project,
    type RunResult,
    type ServiceRequest,
} from "@revisum/engine";
import { baseUrlOf, clearRun, trustedProjectFrom } from "../../support/policy-clearance.ts";
import {
    DEFAULT_CLOCK_START,
    DEFAULT_SEED,
    accepted,
    recordingDriver,
} from "./run-value-examples.ts";
import {
    CALLS,
    ORDER_ID,
    ORIGIN,
    SECRET_VALUES,
    callPlanOf,
    callProject,
    callProjectFile,
    expectBackend,
    routedServiceCaller,
    jsonReply,
    requestLine,
    shopWith,
    type JsonRecord,
    type Reply,
} from "./service-call-examples.ts";
import { fakeClock } from "#test-support/fakes/FakeClock.ts";
import { driversOf, fakePorts } from "#test-support/fakes/FakePorts.ts";
import { fakeSecretStore } from "#test-support/fakes/FakeSecretStore.ts";

const BACKEND_CHECK = 0;
const READ_ORDER = `GET /api/orders/${ORDER_ID}`;
const CHECK_PLAN = callPlanOf([
    expectBackend("getOrder", { orderId: ORDER_ID }, "status", { kind: "equals", value: "paid" }),
]);

const getOrderDeclaredAs = (changes: JsonRecord): JsonRecord => ({
    getOrder: { ...(CALLS["getOrder"] as JsonRecord), ...changes },
});
const AS_WRITE: JsonRecord = { method: "POST", effect: "write", allowInProposals: true };
const AS_DECLARED: JsonRecord = {};

// The field never matches, so a check that went on sending would poll until its timeout.
const orderStillPending = shopWith((request) =>
    requestLine(request).endsWith(`/api/orders/${ORDER_ID}`)
        ? jsonReply(200, { status: "pending" })
        : undefined,
);
const orderPaid = shopWith((request): Reply | undefined =>
    requestLine(request) === READ_ORDER ? jsonReply(200, { status: "paid" }) : undefined,
);

type RunUnderProject = {
    readonly result: RunResult;
    readonly requests: readonly ServiceRequest[];
    readonly elapsed: number;
};

// Parses the plan under the project that declares a read, and runs it under one with `changes` to
// that declaration.
const runUnder = async (
    changes: JsonRecord,
    route: Parameters<typeof routedServiceCaller>[0],
): Promise<RunUnderProject> => {
    const parsedUnder: Project = callProject();
    const plan = accepted(planParser(parsedUnder), CHECK_PLAN);
    const project = callProject(getOrderDeclaredAs(changes));
    const trusted = await trustedProjectFrom(callProjectFile(getOrderDeclaredAs(changes)));
    const { driver } = recordingDriver();
    const { caller, requests } = routedServiceCaller(route);
    const clock = fakeClock();
    const result = await run(
        clearRun(plan, trusted, project.matrix[0]?.id ?? assert.fail("no target")),
        {
            baseUrl: baseUrlOf(ORIGIN),
            seed: DEFAULT_SEED,
            fixedTimeMilliseconds: DEFAULT_CLOCK_START,
            fixtures: [],
            host: { platform: "test", arch: "test" },
        },
        fakePorts({
            drivers: driversOf(driver),
            clock,
            secrets: fakeSecretStore(SECRET_VALUES),
            services: caller,
        }),
    );
    return { result, requests, elapsed: clock.elapsed() };
};

describe("Using the backend check", () => {
    describe("given a plan parsed under a project that declares its call a read", () => {
        describe("and a run under a project that declares the call a write", () => {
            describe("when the run reaches the check", () => {
                test("then it should send nothing and spend no time", async () => {
                    const ran = await runUnder(AS_WRITE, orderStillPending);
                    assert.deepEqual(ran.requests.map(requestLine), []);
                    assert.equal(ran.elapsed, 0);
                });

                test("then it should fail the step, skip the rest and not pass the run", async () => {
                    const ran = await runUnder(AS_WRITE, orderStillPending);
                    assert.deepEqual(
                        ran.result.steps.map((step) => step.outcome),
                        ["failed", "skipped"],
                        JSON.stringify(ran.result.steps),
                    );
                    assert.equal(ran.result.steps[BACKEND_CHECK]?.type, "expectBackend");
                    assert.notEqual(ran.result.state, "Passed");
                });
            });
        });

        describe("and a run under a project that declares the call a read as well", () => {
            describe("when the run reaches the check", () => {
                test("then it should send the read and pass", async () => {
                    const ran = await runUnder(AS_DECLARED, orderPaid);
                    assert.deepEqual(ran.requests.map(requestLine), [READ_ORDER]);
                    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
                });
            });
        });
    });
});
