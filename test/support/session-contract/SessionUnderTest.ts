// The session under test, and the steps and guards the session contract asks it about. The elements
// a step acts on are the Export button and a field labelled Name, which a real page has to hold.
import assert from "node:assert/strict";
import {
    type ActionGuard,
    type GuardVerdict,
    type Origin,
    type PerformableAction,
    type ResolvedDownloadStep,
    type ResolvedElement,
    type ResolvedLocator,
    type Result,
    type Secret,
    type SecretName,
    type Session,
    type SessionTab,
    type Step,
} from "@revisum/engine";
import { testProject } from "../../unit/engine/plan/examples/GoldenPlan.ts";
import { accepted, parserFor, planOf } from "../../unit/engine/run/values/examples/RunPlan.ts";
import { label, navigate, role, testId, type JsonRecord } from "../browser/RawPlan.ts";
import {
    performableActionOf,
    resolvedDownloadOf,
    resolvedLocatorOf,
} from "../PerformableActionOf.ts";
import { PolicyRuleId, PolicyVerdictKind } from "@revisum/contracts";

export type SessionUnderTest = {
    readonly session: Session;
    // Has the page open a dialog saying `text`, and holds until it is open.
    openDialog(text: string): Promise<void>;
    // A page like the session's own, for a new tab to load.
    readonly pageUrl: string;
};
export type OpenSessionUnderTest = () => Promise<SessionUnderTest>;

export const SECRET_NAME = "ACCESS_CODE";
const parsePlan = parserFor({ secretNames: [SECRET_NAME] });

// A step as the parser gives it, so it is one the engine could resolve and hand a driver.
function parsedStep(raw: JsonRecord): Step {
    const plan = accepted(parsePlan, planOf([navigate("/"), raw]));
    const step = plan.steps[1];
    assert.ok(step !== undefined, "the plan keeps its second step");
    return step;
}

// The step as the engine hands it to a driver: a fill of a secret carries the secret given.
export function actionStep(raw: JsonRecord, secret?: Secret): PerformableAction {
    const step = parsedStep(raw);
    assert.ok(
        step.type === "click" || step.type === "fill" || step.type === "dialog",
        JSON.stringify(step),
    );
    return performableActionOf(step, secret);
}

export function downloadStep(locator: JsonRecord): ResolvedDownloadStep {
    const step = parsedStep({ type: "download", name: "report", locator });
    assert.ok(step.type === "download", JSON.stringify(step));
    return resolvedDownloadOf(step);
}

export function locatorOf(raw: JsonRecord): ResolvedLocator {
    const step = parsedStep({ type: "click", locator: raw });
    assert.ok(step.type === "click", JSON.stringify(step));
    return resolvedLocatorOf(step.locator);
}

export function parsedSecretName(name: string): SecretName {
    const step = parsedStep({ ...FILL_THE_SECRET, value: { secretName: name } });
    assert.ok(
        step.type === "fill" && typeof step.value === "object" && "secretName" in step.value,
        JSON.stringify(step),
    );
    return step.value.secretName;
}

export const EXPORT_BUTTON = role("button", "Export");
export const NAME_FIELD = label("Name");
export const CLICK_EXPORT = { type: "click", locator: EXPORT_BUTTON };
export const FILL_THE_SECRET = {
    type: "fill",
    locator: NAME_FIELD,
    value: { secretName: SECRET_NAME },
};
export const ACCEPT = { type: "dialog", action: "accept" };

export type GuardAndQuestions = {
    readonly guard: ActionGuard;
    readonly asked: readonly (readonly [ResolvedElement, string | null])[];
};

// A guard that answers `verdict` and keeps what it was asked.
function guardAnswering(verdict: GuardVerdict): GuardAndQuestions {
    const asked: (readonly [ResolvedElement, string | null])[] = [];
    return {
        asked,
        guard: (element, dialogText) => {
            asked.push([element, dialogText]);
            return verdict;
        },
    };
}
export const allowing = (): GuardAndQuestions => guardAnswering({ kind: PolicyVerdictKind.Allow });
export const denying = (): GuardAndQuestions =>
    guardAnswering({
        kind: PolicyVerdictKind.Deny,
        rule: PolicyRuleId.IrreversibleDialog,
        stepIndex: 1,
    });

export function failureCode(
    result: Result<unknown, { readonly code: string }> | undefined,
): string {
    assert.ok(result?.ok === false, `expected a failure, got ${JSON.stringify(result)}`);
    return result.error.code;
}

export function firstOrigin(): Origin {
    const [origin] = testProject().origins;
    assert.ok(origin !== undefined, "the test project has an origin");
    return origin;
}

export const locatorFindingNothing = (): ResolvedLocator => locatorOf(testId("not-on-the-page"));

export function assertNothingRead(probe: Awaited<ReturnType<Session["probe"]>>): void {
    assert.deepEqual(probe, { count: "page-unreadable" });
}

export async function openTab(subject: SessionUnderTest): Promise<SessionTab> {
    const opened = await subject.session.newTab(subject.pageUrl);
    assert.ok(opened.ok, `the tab opens: ${JSON.stringify(opened)}`);
    return opened.value;
}
