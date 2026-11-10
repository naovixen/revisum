// A planner call that fails says so in its answer, in code a caller must look at. Only a failure the
// adapter expected is one: a programming error stays an error, and is never reported as a call that
// the planner refused.
import assert from "node:assert/strict";
import { Server as NetServer } from "node:net";
import { describe, test } from "node:test";
import { ServiceCallErrorCode } from "@revisum/contracts";
import { buildAdapters, plannerAdapter } from "@revisum/cli";
import {
    MAXIMUM_PLANNER_REPLY_BYTES,
    failure,
    parseProject,
    success,
    type DraftRequest,
    type PlannerEndpoint,
    type ServiceCaller,
} from "@revisum/engine";
import { fakeSecretStore } from "#test-support/fakes/ports/FakeSecretStore.ts";
import { fakeServiceCaller } from "#test-support/fakes/services/FakeServiceCaller.ts";
import { localPlanner, projectFile } from "../commands/examples/DraftCommand.ts";

const REPLY = new TextEncoder().encode('{"reply":"text"}');
const WHY_IT_BROKE = "a bug in the code, not a planner that failed";

const answered = (status: number, body: Uint8Array = REPLY) =>
    Promise.resolve(success({ status, mediaType: "application/json", body }));

const DRAFT_REQUEST: DraftRequest = {
    criteria: [],
    grammarVersion: "v1",
    origins: [],
    targets: [],
};

const REQUEST_THAT_BREAKS: DraftRequest = new Proxy(DRAFT_REQUEST, {
    get: (target, property): unknown => {
        if (property === "criteria") {
            throw new TypeError(WHY_IT_BROKE);
        }
        return Reflect.get(target, property);
    },
});

const endpoint = (): PlannerEndpoint => {
    const project = parseProject(projectFile(localPlanner("http://127.0.0.1:9")));
    assert.ok(project.ok, JSON.stringify(project));
    assert.ok(project.value.planner !== undefined, "the project has no planner");
    return project.value.planner;
};

const draftThrough = (call: ServiceCaller["call"]) => {
    const adapter = plannerAdapter(endpoint(), {
        caller: fakeServiceCaller({ call }),
        secrets: fakeSecretStore(),
    });
    assert.ok(adapter.ok, JSON.stringify(adapter));
    return adapter.value.draft(DRAFT_REQUEST);
};

describe("Using a planner adapter", () => {
    describe("given a planner that answers with a success", () => {
        describe("when a draft is asked for", () => {
            test("then it should answer with the reply as received", async () => {
                assert.deepEqual(await draftThrough(() => answered(200)), success(REPLY));
            });
        });
    });

    describe("given a service caller that fails", () => {
        describe("when a draft is asked for", () => {
            test("then it should answer with the caller's code", async () => {
                const drafted = await draftThrough(() =>
                    Promise.resolve(failure(ServiceCallErrorCode.ServiceUnreachable)),
                );
                assert.deepEqual(drafted, failure(ServiceCallErrorCode.ServiceUnreachable));
            });
        });
    });

    describe("given a planner that answers with a failing status", () => {
        describe("when a draft is asked for", () => {
            test("then it should answer with the planner-status code", async () => {
                assert.deepEqual(
                    await draftThrough(() => answered(500)),
                    failure("planner-status"),
                );
            });
        });
    });

    describe("given a reply past the size limit", () => {
        describe("when a draft is asked for", () => {
            test("then it should answer with the response-too-large code", async () => {
                const tooLong = new Uint8Array(MAXIMUM_PLANNER_REPLY_BYTES + 1);
                assert.deepEqual(
                    await draftThrough(() => answered(200, tooLong)),
                    failure("response-too-large"),
                );
            });
        });
    });

    describe("given a service caller with a programming error", () => {
        describe("when a draft is asked for", () => {
            test("then it should reject with that error", async () => {
                const broken = new TypeError(WHY_IT_BROKE);
                await assert.rejects(
                    draftThrough(() => Promise.reject(broken)),
                    broken,
                );
            });
        });
    });
});

describe("Using the planner calls", () => {
    describe("given a request whose reading is a programming error", () => {
        describe("when the planner is called", () => {
            test("then it should reject with that error and close its proxy", async (context) => {
                const listen = context.mock.method(NetServer.prototype, "listen");
                const call = buildAdapters.plannerCalls({ secrets: fakeSecretStore() });
                await assert.rejects(
                    call(endpoint(), REQUEST_THAT_BREAKS),
                    new TypeError(WHY_IT_BROKE),
                );
                const stillListening = listen.mock.calls.filter(
                    (made) => made.this instanceof NetServer && made.this.listening,
                );
                assert.equal(stillListening.length, 0, "the planner's proxy was left listening");
            });
        });
    });
});
