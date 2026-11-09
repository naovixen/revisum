// Shared setup for the browser tests of the plan language's page parts: css and XPath locators, DOM
// checks and page scripts, carried out by the own CDP driver.
//
// It serves the unsafe-features fixture app (test/fixtures/sites/unsafe-features-app/). Beside the app's files
// it answers two routes: /orders.html, whose order row carries a canary order id made fresh for the
// harness, and /leaks.html, served with a session cookie, readable by scripts, holding a canary.
//
// The trusted project enables css locators, XPath locators, DOM checks, named page scripts and
// inline scripts, and lists one css selector, button.icon-close, that may resolve a control with no
// accessible name. Its named scripts are the files under the fixture project's plans/scripts/
// folder (test/fixtures/plans/unsafe-features-project/), passed to the run as its script sources, keyed by
// each declared file path. Its target is the own CDP driver on Chrome for Testing. It declares one
// secret, typed into the leak page.
//
// Plans are cleared through the policy gate as a proposal unless a standing is given. Every run
// reads chosen test ids just before the run closes its session, such as the input-event counter
// every fixture page keeps (counting.js), so a test can show what a refused or denied step did not
// send.
//
// A script's source is one function expression, called once with one object of named JSON arguments.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserDriver } from "@revisum/engine";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget, englishMatrix } from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/driver/CreateBrowserDriver.ts";
import { rawPlan, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";
import { letterNonce } from "../../../unit/engine/secrets/examples/SecretRun.ts";

const SEED = 36;
// The run's own clock start: 31 October 2026, 12:00 UTC.
export const CLOCK_START_MILLISECONDS = Date.UTC(2026, 9, 31, 12, 0, 0);
// Longer than any script timeout below, so a script timeout can be told from a step timeout.
export const STEP_TIMEOUT_MILLISECONDS = 5000;
// How long an expectScript check repeats before it fails.
const SCRIPT_CHECK_TIMEOUT_MILLISECONDS = 1000;
// The most scripts one run may call. Every script call counts toward it.
const MAXIMUM_CALLS = 200;

export const UNSAFE_PAGE_TARGETS = [BrowserTarget.Chrome] as const;

// The secret the leak page's token field is filled with.
export const PAGE_SECRET = "PAGE_ACCESS_TOKEN";

// The one selector the project allows to resolve a control with no accessible name.
export const ALLOWED_UNNAMED_SELECTOR = "button.icon-close";

export const FIXTURE_FOLDER = join(FIXTURES, "sites", "unsafe-features-app");
const PROJECT_FOLDER = join(FIXTURES, "plans", "unsafe-features-project");

export const ECHO_ARGUMENTS_FILE = "plans/scripts/echo-arguments.js";
const HOSTILE_RESULT_FILE = "plans/scripts/hostile-result.js";
const HOSTILE_EGRESS_FILE = "plans/scripts/hostile-egress.js";
const LEAKY_RESULT_FILE = "plans/scripts/leaky-result.js";
const COUNT_RUN_FILE = "plans/scripts/count-run.js";
const SCRIPT_FILES = [
    ECHO_ARGUMENTS_FILE,
    HOSTILE_RESULT_FILE,
    HOSTILE_EGRESS_FILE,
    LEAKY_RESULT_FILE,
    COUNT_RUN_FILE,
] as const;

// A declared script file's bytes, as the protected branch would hold them.
const scriptFileBytes = (file: string): Uint8Array =>
    new Uint8Array(readFileSync(join(PROJECT_FOLDER, file)));
export const scriptFileText = (file: string): string =>
    new TextDecoder("utf-8", { fatal: true }).decode(scriptFileBytes(file));

// What echoArguments accepts: text of up to this many characters, a whole number and a boolean.
export const ECHO_TEXT_MAXIMUM_LENGTH = 200;
export const ECHO_COUNT_MAXIMUM = 1_000_000;

// The kinds of result hostileResult gives, by its `kind` argument. `sized` pads its result with
// `amount` characters; `nested` wraps a value in `amount` arrays.
const HOSTILE_RESULT_KINDS = [
    "plain",
    "sized",
    "nested",
    "cyclic",
    "undefined",
    "function",
    "throws",
    "rejects",
    "never-settles",
] as const;
export type HostileResultKind = (typeof HOSTILE_RESULT_KINDS)[number];
// hostileResult's own limits: a result over this many bytes is too large, and it times out after this long.
export const HOSTILE_RESULT_MAXIMUM_BYTES = 1024;
export const HOSTILE_RESULT_TIMEOUT_MILLISECONDS = 1000;

const PAGE_SCRIPTS: JsonRecord = {
    echoArguments: {
        file: ECHO_ARGUMENTS_FILE,
        parameters: {
            text: { kind: "text", maximumLength: ECHO_TEXT_MAXIMUM_LENGTH },
            count: { kind: "integer", minimum: 0, maximum: ECHO_COUNT_MAXIMUM },
            flag: { kind: "boolean" },
        },
        effect: "read",
        fields: { report: "/report" },
        allowInProposals: false,
    },
    hostileResult: {
        file: HOSTILE_RESULT_FILE,
        parameters: {
            kind: { kind: "oneOf", values: [...HOSTILE_RESULT_KINDS] },
            amount: { kind: "integer", minimum: 0, maximum: 100_000 },
        },
        effect: "read",
        fields: { shape: "/shape" },
        allowInProposals: false,
        timeoutMilliseconds: HOSTILE_RESULT_TIMEOUT_MILLISECONDS,
        maximumResultBytes: HOSTILE_RESULT_MAXIMUM_BYTES,
    },
    hostileEgress: {
        file: HOSTILE_EGRESS_FILE,
        parameters: {},
        effect: "write",
        fields: { attempts: "/attempts" },
        allowInProposals: true,
        timeoutMilliseconds: 10_000,
    },
    leakyResult: {
        file: LEAKY_RESULT_FILE,
        parameters: {},
        effect: "read",
        fields: { status: "/status", itemCount: "/itemCount" },
        allowInProposals: false,
    },
    countRun: {
        file: COUNT_RUN_FILE,
        parameters: {},
        effect: "write",
        fields: { runs: "/runs" },
        allowInProposals: true,
    },
};

// `extraOrigins` widens the browser's allow-list, for the egress tests, where only the proxy
// outside the browser may stand in the way.
const unsafePageProjectFile = (origin: string, extraOrigins: readonly string[] = []) => ({
    origins: [origin, ...extraOrigins],
    limits: {
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        scriptCheckTimeoutMilliseconds: SCRIPT_CHECK_TIMEOUT_MILLISECONDS,
        maximumCalls: MAXIMUM_CALLS,
        maximumSteps: 1000,
        maximumPlanBytes: 1024 * 1024,
        maximumTextLength: 4000,
    },
    secretNames: [PAGE_SECRET],
    matrix: englishMatrix([BrowserTarget.Chrome]),
    unsafeFeatures: {
        cssLocators: true,
        xpathLocators: true,
        domChecks: true,
        pageScripts: { scripts: PAGE_SCRIPTS, allowInline: true },
        unnamedControlsAllowed: [ALLOWED_UNNAMED_SELECTOR],
    },
});

export const unsafePageDrivers = (): ReadonlyMap<string, BrowserDriver> =>
    driversForTargets([BrowserTarget.Chrome]);

export const css = (selector: string, fields: JsonRecord = {}): JsonRecord => ({
    by: "css",
    selector,
    ...fields,
});
export const xpath = (expression: string, fields: JsonRecord = {}): JsonRecord => ({
    by: "xpath",
    expression,
    ...fields,
});

export const check = (
    locator: JsonRecord,
    assertion: JsonRecord,
    criterionId: string,
): JsonRecord => ({ type: "expect", locator, assert: assertion, criterionId });
export const rememberAttribute = (
    name: string,
    element: JsonRecord,
    attribute: string,
): JsonRecord => ({ type: "remember", name, from: { element, read: "attribute", attribute } });

export const evaluate = (
    script: unknown,
    scriptArguments: JsonRecord = {},
    remember?: JsonRecord,
): JsonRecord => ({
    type: "evaluate",
    script,
    arguments: scriptArguments,
    ...(remember === undefined ? {} : { remember }),
});
export const expectScript = (
    script: unknown,
    scriptArguments: JsonRecord,
    field: string,
    assertion: JsonRecord,
    criterionId: string,
): JsonRecord => ({
    type: "expectScript",
    script,
    arguments: scriptArguments,
    field,
    assert: assertion,
    criterionId,
});
export const inlineScript = (
    source: string,
    effect: "read" | "write",
    fields: JsonRecord,
): JsonRecord => ({ inline: { source, effect, fields } });
export const hostileResult = (kind: HostileResultKind, amount = 0): JsonRecord =>
    evaluate("hostileResult", { kind, amount });

// The Continue button on the index page, and the check that it was pressed: a run that reaches
// them sends input and passes; a run stopped before them leaves the page untouched.
export const continueStep = (): JsonRecord => ({
    type: "click",
    locator: { by: "role", role: "button", name: "Continue" },
});
export const continued = (): JsonRecord =>
    check(
        { by: "testId", testId: "continue-state" },
        { kind: "textEquals", value: "Continued" },
        "page.continued",
    );

export const unsafePagePlan = (
    targetId: string,
    steps: readonly unknown[],
    fields: JsonRecord = {},
): JsonRecord =>
    rawPlan(
        {
            featureId: "UNSAFE-1",
            specReference: "specs/unsafe-page-parts.md#driver",
            title: "Unsafe page features in a browser",
        },
        targetId,
        steps,
        fields,
    );

// Values made fresh for one harness. Each begins with no step type, field or header name, so a leak
// scan's prefix check can only match the value itself.
type Canaries = { readonly orderId: string; readonly sessionCookie: string };

function routesFor(canaries: Canaries): ReadonlyMap<string, FixtureRoute> {
    const ordersTemplate = readFileSync(join(FIXTURE_FOLDER, "orders.html"), "utf8");
    const leaksPage = readFileSync(join(FIXTURE_FOLDER, "leaks.html"), "utf8");
    return new Map<string, FixtureRoute>([
        [
            "/orders.html",
            () => ({
                headers: { "content-type": "text/html; charset=utf-8" },
                body: ordersTemplate.replace("ORDER_ID", canaries.orderId),
            }),
        ],
        [
            "/leaks.html",
            () => ({
                headers: {
                    "content-type": "text/html; charset=utf-8",
                    "set-cookie": `session_id=${canaries.sessionCookie}; Path=/; SameSite=Lax`,
                },
                body: leaksPage,
            }),
        ],
    ]);
}

export type UnsafePageHarness = BrowserHarness & {
    readonly canaries: Canaries;
    // The fixture project's script files, keyed by declared file path.
    readonly scriptSources: Readonly<Record<string, Uint8Array>>;
};

type UnsafePageHarnessOptions = { readonly extraOrigins?: readonly string[] };

export async function unsafePageHarness(
    options: UnsafePageHarnessOptions = {},
): Promise<UnsafePageHarness> {
    const nonce = letterNonce(10);
    const canaries: Canaries = {
        orderId: `Zqorder${nonce}ref${nonce}`,
        sessionCookie: `Zqsession${nonce}cookie`,
    };
    const scriptSources = Object.fromEntries(
        SCRIPT_FILES.map((file) => [file, scriptFileBytes(file)]),
    );
    const harness = await startBrowserHarness({
        fixtureFolder: FIXTURE_FOLDER,
        routes: routesFor(canaries),
        projectFile: (origin) => unsafePageProjectFile(origin, options.extraOrigins ?? []),
        seed: SEED,
        fixedTimeMilliseconds: CLOCK_START_MILLISECONDS,
        drivers: unsafePageDrivers(),
        planFor: unsafePagePlan,
        readAtClose: ["input-events"],
        scriptSources,
    });
    return { ...harness, canaries, scriptSources };
}
