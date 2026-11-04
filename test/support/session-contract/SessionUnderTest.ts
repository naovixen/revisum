// The session under test, and the steps and guards the session contract asks it about. The elements
// a step acts on are the Export button and a field labelled Name, which a real page has to hold.
import assert from "node:assert/strict";
import {
    DRIVER_FEATURES,
    performableLocator,
    type ActionGuard,
    type ActionStep,
    type DownloadStep,
    type GuardVerdict,
    type Locator,
    type Origin,
    type ResolvedElement,
    type ResolvedLocator,
    type Result,
    type SecretName,
    type Session,
    type Step,
} from "@revisum/engine";
import { testProject } from "../../unit/engine/plan-examples.ts";
import { accepted, parserFor, planOf, reference } from "../../unit/engine/run-value-examples.ts";
import { label, navigate, role, testId, type JsonRecord } from "../browser/RawPlan.ts";

export type SessionUnderTest = {
    readonly session: Session;
    // Has the page open a dialog saying `text`, and holds until it is open.
    openDialog(text: string): Promise<void>;
    // A page like the session's own, for a new tab to load.
    readonly pageUrl: string;
};
export type OpenSessionUnderTest = () => Promise<SessionUnderTest>;

export const SECRET_NAME = "ACCESS_CODE";
export const ANOTHER_SECRET_NAME = "ANOTHER_CODE";
const VALUE_NAME = "orderCode";
const parsePlan = parserFor({ secretNames: [SECRET_NAME, ANOTHER_SECRET_NAME] });

// A step as the parser gives it, so it is one the engine could hand a driver.
function parsedStep(raw: JsonRecord): Step {
    const plan = accepted(
        parsePlan,
        planOf([navigate("/"), raw], {
            values: { [VALUE_NAME]: { kind: "uniqueText", prefix: "order" } },
        }),
    );
    const step = plan.steps[1];
    assert.ok(step !== undefined, "the plan keeps its second step");
    return step;
}

export function actionStep(raw: JsonRecord): ActionStep {
    const step = parsedStep(raw);
    assert.ok(
        step.type === "click" || step.type === "fill" || step.type === "dialog",
        JSON.stringify(step),
    );
    return step;
}

export function downloadStep(locator: JsonRecord): DownloadStep {
    const step = parsedStep({ type: "download", name: "report", locator });
    assert.ok(step.type === "download", JSON.stringify(step));
    return step;
}

export function locatorOf(raw: JsonRecord): Locator {
    const step = parsedStep({ type: "click", locator: raw });
    assert.ok(step.type === "click", JSON.stringify(step));
    return step.locator;
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
export const HOLDING_A_VALUE = testId(reference(VALUE_NAME));
export const A_LEFT_REFERENCE = reference(VALUE_NAME);
export const CLICK_EXPORT = { type: "click", locator: EXPORT_BUTTON };
export const FILL_THE_SECRET = {
    type: "fill",
    locator: NAME_FIELD,
    value: { secretName: SECRET_NAME },
};
export const ACCEPT = { type: "dialog", action: "accept" };
export const NO_GUARD = undefined as unknown as ActionGuard;

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
export const allowing = (): GuardAndQuestions => guardAnswering({ kind: "allow" });
export const denying = (): GuardAndQuestions =>
    guardAnswering({ kind: "deny", rule: "irreversible-dialog", stepIndex: 1 });

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

export function locatorFindingNothing(): ResolvedLocator {
    const locator = performableLocator(locatorOf(testId("not-on-the-page")), DRIVER_FEATURES);
    assert.ok(locator !== undefined, "the locator holds no value reference");
    return locator;
}

export function assertNothingRead(probe: Awaited<ReturnType<Session["probe"]>>): void {
    assert.deepEqual(
        { count: probe.count, visible: probe.visible, enabled: probe.enabled },
        { count: "page-unreadable", visible: false, enabled: false },
    );
}

export async function openTab(subject: SessionUnderTest): Promise<Session> {
    const opened = await subject.session.newTab?.(subject.pageUrl);
    assert.ok(opened?.ok === true, `the tab opens: ${JSON.stringify(opened)}`);
    return opened.value;
}
