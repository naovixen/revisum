// The planner endpoint in the trusted project.json. An API key never travels over plain HTTP, so a
// customer-key endpoint must be https:, and the project parser refuses an http: one with its
// existing code for a URL whose scheme is not allowed, at the endpoint's url. A local endpoint,
// which the draft command keeps to loopback, may be http:.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseProject } from "@revisum/engine";
import {
    customerKeyPlanner,
    localPlanner,
    projectFile,
    PLANNER_HOST,
} from "../../cli/commands/examples/DraftCommand.ts";

// The fields every endpoint keeps as written: its kind, address, model and wire format.
const keptFields = (endpoint: unknown): readonly unknown[] =>
    ["kind", "url", "model", "wire"].map((field) => {
        const kept: unknown =
            typeof endpoint === "object" && endpoint !== null
                ? Reflect.get(endpoint, field)
                : undefined;
        return kept;
    });

test("a customer-key endpoint over plain http is refused with scheme_not_allowed at its url", () => {
    for (const wire of ["anthropic-messages", "openai-chat"] as const) {
        const parsed = parseProject(
            projectFile(customerKeyPlanner(wire, `http://${PLANNER_HOST}`)),
        );
        assert.equal(parsed.ok, false, `${wire}: the http endpoint was accepted`);
        assert.deepEqual(parsed.error, [{ code: "scheme_not_allowed", path: "$.planner.url" }]);
    }
});

test("counter-example: the same endpoint over https is accepted and kept", () => {
    const planner = customerKeyPlanner("anthropic-messages");
    const parsed = parseProject(projectFile(planner));
    assert.ok(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.error));
    assert.deepEqual(keptFields(Reflect.get(parsed.value, "planner")), keptFields(planner));
});

test("a local endpoint on loopback may be plain http", () => {
    const planner = localPlanner("http://127.0.0.1:11434");
    const parsed = parseProject(projectFile(planner));
    assert.ok(parsed.ok, JSON.stringify(parsed.ok ? null : parsed.error));
    assert.deepEqual(keptFields(Reflect.get(parsed.value, "planner")), keptFields(planner));
});
