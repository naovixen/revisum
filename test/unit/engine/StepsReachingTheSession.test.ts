// Every step of the plan language goes to the session, whichever step it is: a run never refuses one
// for what a driver might lack.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    advanceClock,
    expectClipboard,
    rememberClipboard,
} from "./clock-and-clipboard-examples.ts";
import {
    OPEN_ORDERS,
    ORIGIN,
    PAGE_TITLE,
    label,
    navigate,
    planOf,
    projectFileWith,
    runPlan,
    type JsonRecord,
} from "./run-value-examples.ts";
import {
    expectRequests,
    expectResponse,
    expectStorage,
    rememberResponse,
    removeStorage,
    resetRequests,
    setStorage,
    startStub,
    stubProjectFile,
} from "./stub-and-storage-examples.ts";

const AFTER: JsonRecord = {
    type: "click",
    locator: { by: "role", role: "button", name: "Continue" },
};
const TAB: JsonRecord = { by: "role", role: "tab", name: "Billing" };
const LINK: JsonRecord = { by: "role", role: "link", name: "Billing guide" };
const EXPORT_BUTTON: JsonRecord = { by: "role", role: "button", name: "Export CSV" };
const NEW_TAB_STEPS: readonly JsonRecord[] = [
    { type: "fill", locator: label("Search"), value: "Website relaunch" },
    {
        type: "expect",
        locator: { by: "role", role: "heading", name: "Your account" },
        assert: { kind: "visible" },
        criterionId: "settings.account-shown",
    },
];

const expectOn = (locator: JsonRecord, assertion: JsonRecord): JsonRecord => ({
    type: "expect",
    locator,
    assert: assertion,
    criterionId: "settings.billing-shown",
});
const expectPage = (assertion: JsonRecord): JsonRecord => ({
    type: "expectPage",
    assert: assertion,
    criterionId: "settings.page-shown",
});

// The project a locator's or a network step's declarations need.
const LOCATOR_PROJECT = projectFileWith({
    testIdAttributes: ["data-testid", "data-qa"],
    policy: { unnamedControlsAllowedByTestId: ["save"] },
});
const NETWORK_PROJECT = stubProjectFile();

const ACTIONS_WITH_THEIR_PLAINER_FORMS: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly plainer: JsonRecord;
}[] = [
    {
        name: "a positioned locator",
        step: { type: "click", locator: { by: "role", role: "button", name: "Open", position: 2 } },
        plainer: { type: "click", locator: { by: "role", role: "button", name: "Open" } },
    },
    {
        name: "a declared test-id attribute",
        step: { type: "click", locator: { by: "testId", testId: "save", attribute: "data-qa" } },
        plainer: { type: "click", locator: { by: "testId", testId: "save" } },
    },
    {
        name: "a key chord",
        step: { type: "press", locator: label("Search"), key: "Enter", modifiers: ["Shift"] },
        plainer: { type: "press", locator: label("Search"), key: "Enter" },
    },
    {
        name: "a multi-line fill",
        step: {
            type: "fill",
            locator: label("Message"),
            value: { lines: ["Hello", "Second line"] },
        },
        plainer: { type: "fill", locator: label("Message"), value: "Hello" },
    },
];

const PLAIN_CHECKS: readonly { readonly name: string; readonly step: JsonRecord }[] = [
    { name: "a visible check on a tab", step: expectOn(TAB, { kind: "visible" }) },
    { name: "a visible check on a link", step: expectOn(LINK, { kind: "visible" }) },
    { name: "a title check", step: expectPage({ kind: "title", value: PAGE_TITLE }) },
    { name: "a URL path check", step: expectPage({ kind: "urlPath", value: "/orders" }) },
];

// Each is one a port may answer however it likes: only a refusal for want of a feature is wrong.
const STEPS_ONCE_REFUSED_FOR_WANT_OF_A_FEATURE: readonly {
    readonly name: string;
    readonly step: JsonRecord;
    readonly projectFile?: JsonRecord;
}[] = [
    ...["selected", "unselected", "expanded", "collapsed", "pressed", "unpressed", "current"].map(
        (kind) => ({ name: `the state check "${kind}"`, step: expectOn(TAB, { kind }) }),
    ),
    {
        name: "a link-target check",
        step: expectOn(LINK, { kind: "hrefEquals", value: `${ORIGIN}/help/billing` }),
    },
    {
        name: "a meta tag check",
        step: expectPage({ kind: "metaContent", name: "og:title", value: PAGE_TITLE }),
    },
    {
        name: "a canonical URL check",
        step: expectPage({ kind: "canonicalUrl", value: `${ORIGIN}/orders` }),
    },
    {
        name: "a navigate with scripts disabled",
        step: { ...navigate("/events/team-meeting"), scripts: "disabled" },
    },
    {
        name: "a download",
        step: { type: "download", name: "project-list", locator: EXPORT_BUTTON },
    },
    { name: "a newTab", step: { type: "newTab", url: "/account", steps: NEW_TAB_STEPS } },
    {
        name: "a remember step",
        step: {
            type: "remember",
            name: "orderNumber",
            from: { element: label("Order number"), read: "text" },
        },
    },
    ...ACTIONS_WITH_THEIR_PLAINER_FORMS.map(({ name, step }) => ({
        name,
        step,
        projectFile: LOCATOR_PROJECT,
    })),
    ...[
        { name: "a stub start", step: startStub("loginNeedsCode", { reason: "Enter the code" }) },
        { name: "a stub start with no arguments", step: startStub("cartEmpty") },
        { name: "a resetRequests", step: resetRequests("likes") },
        { name: "an expectRequests", step: expectRequests("scheduleLoads", { equals: 0 }) },
        {
            name: "an expectResponse",
            step: expectResponse("likes", { kind: "statusEquals", value: 200 }),
        },
        {
            name: "a remember from a response",
            step: rememberResponse("likeCount", "likes", "likeList", "arrayLength"),
        },
        { name: "a setStorage", step: setStorage("pinnedMenu", { docked: true }) },
        { name: "a removeStorage", step: removeStorage("pinnedMenu") },
        { name: "an expectStorage", step: expectStorage("privateKey", { kind: "absent" }) },
    ].map((entry) => ({ ...entry, projectFile: NETWORK_PROJECT })),
    { name: "an advanceClock in the default mode", step: advanceClock(1, "hours") },
    { name: "an advanceClock in runTimers mode", step: advanceClock(1, "hours", "runTimers") },
    { name: "an advanceClock in skipAhead mode", step: advanceClock(1, "hours", "skipAhead") },
    {
        name: "an expectClipboard with textEquals",
        step: expectClipboard("textEquals", "https://example.test/invite/abc"),
    },
    {
        name: "an expectClipboard with multi-line textEquals",
        step: expectClipboard("textEquals", { lines: ["Ada Lovelace", "London"] }),
    },
    {
        name: "an expectClipboard with textContains",
        step: expectClipboard("textContains", "/invite/"),
    },
    {
        name: "an expectClipboard with textExcludes",
        step: expectClipboard("textExcludes", "password"),
    },
    { name: "a remember from the clipboard", step: rememberClipboard("inviteLink") },
];

describe("Using a run", () => {
    for (const { name, step, plainer } of ACTIONS_WITH_THEIR_PLAINER_FORMS) {
        for (const [form, action] of [
            [name, step],
            [`the plainer form of ${name}`, plainer],
        ] as const) {
            describe(`given a plan with ${form}`, () => {
                describe("when it is run", () => {
                    test("then it should send its actions and pass", async () => {
                        const { result, recording } = await runPlan(
                            planOf([OPEN_ORDERS, action, AFTER]),
                            { projectFile: LOCATOR_PROJECT },
                        );
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                        assert.deepEqual(
                            recording.actions.map((sent) => sent.type),
                            [String(action["type"]), "click"],
                        );
                    });
                });
            });
        }
    }

    for (const { name, step } of PLAIN_CHECKS) {
        describe(`given a plan with ${name}`, () => {
            describe("when it is run", () => {
                test("then it should check the page, send the click after it and pass", async () => {
                    const { result, recording } = await runPlan(planOf([OPEN_ORDERS, step, AFTER]));
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    assert.equal(recording.actions.length, 1);
                });
            });
        });
    }

    for (const { name, step, projectFile } of STEPS_ONCE_REFUSED_FOR_WANT_OF_A_FEATURE) {
        describe(`given a plan with ${name}`, () => {
            describe("when it is run", () => {
                test("then it should not call it an unsupported step", async () => {
                    const { result } = await runPlan(
                        planOf([OPEN_ORDERS, step, AFTER]),
                        projectFile === undefined ? {} : { projectFile },
                    );
                    assert.equal(result.steps[0]?.outcome, "passed");
                    assert.ok(result.steps[1] !== undefined);
                    assert.notEqual(
                        result.steps[1].code,
                        "unsupported-step",
                        JSON.stringify(result.steps),
                    );
                });
            });
        });
    }

    describe("given a navigate", () => {
        describe("when it is run", () => {
            test("then it should load the page", async () => {
                const { result, recording } = await runPlan(
                    planOf([OPEN_ORDERS, navigate("/events/team-meeting"), AFTER]),
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.deepEqual(recording.navigations, [
                    `${ORIGIN}/orders`,
                    `${ORIGIN}/events/team-meeting`,
                ]);
            });
        });
    });

    describe("given a click on the button a download would use", () => {
        describe("when it is run", () => {
            test("then it should reach the driver", async () => {
                const { result, recording } = await runPlan(
                    planOf([OPEN_ORDERS, { type: "click", locator: EXPORT_BUTTON }]),
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.deepEqual(
                    recording.actions.map((sent) => sent.type),
                    ["click"],
                );
            });
        });
    });

    describe("given the steps of a new tab, in the first tab", () => {
        describe("when they are run", () => {
            test("then it should reach the driver with them", async () => {
                const { result, recording } = await runPlan(
                    planOf([OPEN_ORDERS, navigate("/account"), ...NEW_TAB_STEPS, AFTER]),
                );
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                assert.deepEqual(recording.navigations, [`${ORIGIN}/orders`, `${ORIGIN}/account`]);
                assert.deepEqual(
                    recording.actions.map((sent) => sent.type),
                    ["fill", "click"],
                );
            });
        });
    });

    for (const [name, projectFile] of [
        ["the network project", NETWORK_PROJECT],
        ["the plain project", projectFileWith()],
    ] as const) {
        describe(`given a plan with none of the port steps, on ${name}`, () => {
            describe("when it is run", () => {
                test("then it should click, check the page and pass", async () => {
                    const { result, recording } = await runPlan(planOf([OPEN_ORDERS, AFTER]), {
                        projectFile,
                    });
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    assert.deepEqual(recording.navigations, [`${ORIGIN}/orders`]);
                    assert.deepEqual(
                        recording.actions.map((sent) => sent.type),
                        ["click"],
                    );
                    assert.ok(recording.probes > 0, "the closing check read the page");
                });
            });
        });
    }
});
