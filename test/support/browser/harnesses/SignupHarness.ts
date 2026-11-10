// Shared setup for the driver contract and the run guarantees: the trusted project, the driver
// registry, the sign-up fixture app and the plans, written as raw JSON the way a person or an AI
// planner would write them.
import { join } from "node:path";
import { parseProject, type BrowserDriver, type Project } from "@revisum/engine";
import { startBrowserHarness, type BrowserHarness } from "../BrowserHarness.ts";
import { ADAPTER_OF_TARGET, BrowserTarget } from "../BrowserTarget.ts";
import { driversForTargets } from "../driver/CreateBrowserDriver.ts";
import {
    PLAN_LANGUAGE_VERSION,
    label,
    rawPlan,
    role,
    testId,
    visible,
    type JsonRecord,
} from "../RawPlan.ts";
import { FIXTURES } from "../../repository/RepositoryRoot.ts";

export const SEED = 42;
export const FIXED_TIME_MILLISECONDS = Date.UTC(2026, 0, 15, 10, 30, 0);
export const LOCALE = "de-DE";
export const TIMEZONE = "Asia/Tokyo";

// Every driver must pass the contract unchanged on each of these targets. The own CDP driver runs
// it twice: on Chrome for Testing and on its headless shell, the build CI uses.
export const CONTRACT_TARGETS = [BrowserTarget.Chrome, BrowserTarget.HeadlessShell] as const;

const desktop = {
    device: "desktop-1280",
    locale: LOCALE,
    timezone: TIMEZONE,
    colorScheme: "dark",
    reducedMotion: "reduce",
} as const;

const contractTarget = (target: BrowserTarget) => ({
    id: target,
    adapter: ADAPTER_OF_TARGET[target],
    engine: "chromium",
    ...desktop,
});

// The project file as a person writes it. Its targets' locale, de-DE, is covered by the engine's
// built-in German irreversible patterns, so it needs no policy of its own.
export const makeProjectFile = (origin: string) => ({
    origins: [origin],
    limits: { stepTimeoutMilliseconds: 2000 },
    matrix: [
        contractTarget(BrowserTarget.Chrome),
        // The same CDP driver, given the headless shell's executable instead of Chrome for Testing's.
        contractTarget(BrowserTarget.HeadlessShell),
        // A target no registered driver can serve, to prove it is reported and never substituted.
        {
            id: "appium-android",
            adapter: "appium",
            engine: "chromium",
            ...desktop,
            device: "phone-390",
        },
    ],
});

export function makeProject(origin: string): Project {
    const parsed = parseProject(makeProjectFile(origin));
    if (!parsed.ok) {
        throw new Error(`bad test project: ${JSON.stringify(parsed.error)}`);
    }
    return parsed.value;
}

export const makeDrivers = (): ReadonlyMap<string, BrowserDriver> =>
    driversForTargets(Object.values(BrowserTarget));

const meta = (title: string) => ({
    featureId: "SIGNUP-1",
    specReference: "specs/signup.md#happy-path",
    title,
});

export const signupHarness = (): Promise<BrowserHarness> =>
    startBrowserHarness({
        fixtureFolder: join(FIXTURES, "sites", "signup-app"),
        projectFile: makeProjectFile,
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        drivers: makeDrivers(),
        planFor: (targetId, steps, fields) =>
            rawPlan(meta("Contract probe"), targetId, steps, fields),
    });

export const NAME = "Ada Lovelace";
export const EMAIL = "ada@example.test";

export const signupPlan = (targets: readonly string[]) => ({
    version: PLAN_LANGUAGE_VERSION,
    meta: meta("Sign-up happy path"),
    targets,
    steps: [
        { type: "navigate", url: "/" },
        visible(role("heading", "Create your account"), "signup.heading-shown"),
        {
            type: "expectPage",
            assert: { kind: "title", value: "Sign up - Fixture" },
            criterionId: "signup.page-titled",
        },
        { type: "fill", locator: label("Full name"), value: NAME },
        { type: "fill", locator: label("Email"), value: EMAIL },
        {
            type: "expect",
            locator: label("Email"),
            assert: { kind: "valueEquals", value: EMAIL },
            criterionId: "signup.email-kept",
        },
        { type: "capture", name: "form-filled" },
        { type: "click", locator: role("checkbox", "I agree to the terms") },
        { type: "click", locator: role("button", "Create account") },
        {
            type: "expect",
            locator: testId("status"),
            assert: { kind: "textContains", value: "Welcome" },
            criterionId: "signup.welcome-shown",
        },
        {
            type: "expect",
            locator: testId("echo"),
            assert: { kind: "textContains", value: "Signed up as" },
            criterionId: "signup.address-echoed",
        },
        { type: "a11yAudit", mode: "report" },
        { type: "capture", name: "signed-up" },
    ],
});

export const environmentPlan = (
    targets: readonly string[],
    expected: Readonly<Record<string, string>>,
) => ({
    version: PLAN_LANGUAGE_VERSION,
    meta: meta("Determinism controls are applied"),
    targets,
    steps: [
        { type: "navigate", url: "/" },
        ...Object.entries(expected).map(([id, value]) => ({
            type: "expect",
            locator: testId(id),
            assert: { kind: "textEquals", value },
            criterionId: `environment.${id}-pinned`,
        })),
    ],
});

const ASSERTION_TYPES: readonly unknown[] = ["expect", "expectPage"];
const isAssertion = (step: unknown): step is JsonRecord =>
    typeof step === "object" &&
    step !== null &&
    ASSERTION_TYPES.includes(Reflect.get(step, "type"));

// A probe plan: navigate, then the given steps. Each given assertion without a criterion id gets
// one. A plan must assert something, so when the given steps hold no assertion, a check that the
// sign-up form is shown is added last; it passes on the fixture app's first page.
export const stepsPlan = (targets: readonly string[], steps: readonly unknown[]) => ({
    version: PLAN_LANGUAGE_VERSION,
    meta: meta("Contract probe"),
    targets,
    steps: [
        { type: "navigate", url: "/" },
        ...steps.map((step, index) =>
            isAssertion(step) && !("criterionId" in step)
                ? { ...step, criterionId: `probe.assertion-${index + 1}` }
                : step,
        ),
        ...(steps.some(isAssertion)
            ? []
            : [visible(role("heading", "Create your account"), "probe.form-shown")]),
    ],
});
