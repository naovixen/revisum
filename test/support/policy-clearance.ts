// Clears a test plan through the policy gate, as every run must, before run(). A run takes only a
// ClearedRun, and only the gate makes one. The project is trusted the way core trusts it: read from
// a protected branch that holds just project.json.
import {
    loadTrustedProject,
    parseBaseUrl,
    policyGate,
    type BaseUrl,
    type ClearedRun,
    type Plan,
    type PlanStanding,
    type Project,
    type TargetId,
    type TrustedProject,
} from "@revisum/engine";
import { fakeEventSink } from "./fakes/FakeEventSink.ts";
import { fakeProtectedBranchHolding } from "./fakes/FakeVersionControlPort.ts";

// The trusted project for a project file, written the way a person writes project.json.
export async function trustedProjectFrom(projectFile: unknown): Promise<TrustedProject> {
    const loaded = await loadTrustedProject(
        "project.json",
        fakeProtectedBranchHolding(projectFile),
        {
            files: [],
            events: fakeEventSink(),
        },
    );
    if (!loaded.ok)
        throw new Error(`the test project was not trusted: ${JSON.stringify(loaded.error)}`);
    return loaded.value.project;
}

// The run the gate clears for the plan on one target, under the project. A missing standing is a
// proposal. A test plan the gate denies is a broken test, so it throws.
export function clearRun(
    plan: Plan,
    project: Project,
    targetId: TargetId,
    standing?: PlanStanding,
): ClearedRun {
    const decision = policyGate({ project, events: fakeEventSink() }).clear(
        plan,
        targetId,
        standing,
    );
    if (decision.kind === "deny") {
        throw new Error(
            `the policy gate denied the test plan: ${decision.rule} at step ${String(decision.stepIndex)}`,
        );
    }
    return decision.run;
}

// A test's base URL, parsed as run() takes it. A test base URL the parser refuses is a broken test.
export function baseUrlOf(url: string): BaseUrl {
    const parsed = parseBaseUrl(url);
    if (!parsed.ok) throw new Error(`the test base URL ${url} was refused: ${parsed.error}`);
    return parsed.value;
}
