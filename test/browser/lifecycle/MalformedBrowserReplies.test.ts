// What the browser answers is outside input like any other, and is parsed before it is used. A reply
// of the wrong shape gives a failure the run can name: never a language error for evidence to quote,
// never a made-up handle sent back to the browser, and never a page that reads as empty or a click
// that reads as landed.
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import type { DriverSession } from "@revisum/driver-cdp";
import { allowEveryAction } from "#test-support/browser/AllowEveryAction.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import type { ReplyChange, SentCommand } from "#test-support/browser/driver/CdpRelay.ts";
import { click, role, testId } from "#test-support/browser/RawPlan.ts";
import { startRelayedDriver, type RelayedDriver } from "#test-support/browser/driver/RelayedDriver.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

shareBrowserInThisFile();

const TARGET = BrowserTarget.Chrome;
const STEP_TIMEOUT_MILLISECONDS = 1000;
const BUTTON = "save";
const PAGE = "/page.html";
const COVERED_PAGE = "/covered.html";
const PAGE_UNREADABLE = "page-unreadable";
const SCRIPT_SOURCE = "function () { return 'ran'; }";
const WHAT_A_LANGUAGE_ERROR_SAYS = /Cannot read|is not a function|is not iterable|TypeError/;

const page =
    (script: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body>
      <main><button type="button" data-testid="${BUTTON}">Save</button></main>
      <div id="cover" style="display:none;position:fixed;inset:0"></div>
      <script>${script}</script>
    </body></html>`,
    });

const ROUTES = new Map<string, FixtureRoute>([
    [PAGE, page("")],
    [
        COVERED_PAGE,
        page(`const cover = document.getElementById('cover');
          window.addEventListener('mousemove', () => { cover.style.display = 'block'; }, { once: true });`),
    ],
]);

const NO_RESULT: ReplyChange = { result: undefined };
const TEXT_RESULT: ReplyChange = { result: "not an object" };
const remoteObject = (fields: Readonly<Record<string, unknown>>): ReplyChange => ({
    result: { result: { type: "object", ...fields } },
});
const NO_REMOTE_OBJECT: ReplyChange = { result: {} };

const resolvedNode = (object: unknown): ReplyChange => ({ result: { object } });
const firstProperty = (value: unknown): ReplyChange => ({
    result: { result: [{ name: "0", value }] },
});

const isScriptCall = ({ parameters }: SentCommand): boolean =>
    parameters["functionDeclaration"] === SCRIPT_SOURCE;

function handlesIn({ parameters }: SentCommand): readonly unknown[] {
    const callArguments = parameters["arguments"];
    const inArguments: readonly unknown[] = Array.isArray(callArguments) ? callArguments : [];
    const handles: unknown[] = [];
    if ("objectId" in parameters) {
        handles.push(parameters["objectId"]);
    }
    for (const argument of inArguments) {
        if (typeof argument === "object" && argument !== null && "objectId" in argument) {
            handles.push(argument.objectId);
        }
    }
    return handles;
}

const isMadeUpHandle = (handle: unknown): boolean => typeof handle !== "string" || handle === "";

const UNREADABLE_REPLIES = [
    {
        name: "the document's object with a null id",
        method: "Runtime.evaluate",
        change: remoteObject({ objectId: null }),
        locator: testId(BUTTON),
    },
    {
        name: "the document's object with an empty id",
        method: "Runtime.evaluate",
        change: remoteObject({ objectId: "" }),
        locator: testId(BUTTON),
    },
    {
        name: "a list of elements with a null id",
        method: "Runtime.callFunctionOn",
        change: remoteObject({ objectId: null }),
        locator: testId(BUTTON),
    },
    {
        name: "a list of elements with an empty id",
        method: "Runtime.callFunctionOn",
        change: remoteObject({ objectId: "" }),
        locator: testId(BUTTON),
    },
    {
        name: "an element of a list with a null id",
        method: "Runtime.getProperties",
        change: firstProperty({ objectId: null }),
        locator: testId(BUTTON),
    },
    {
        name: "an element of a list with an empty id",
        method: "Runtime.getProperties",
        change: firstProperty({ objectId: "" }),
        locator: testId(BUTTON),
    },
    {
        name: "an element of a list that is not an object",
        method: "Runtime.getProperties",
        change: firstProperty(7),
        locator: testId(BUTTON),
    },
    {
        name: "a resolved node with a null id",
        method: "DOM.resolveNode",
        change: resolvedNode({ objectId: null }),
        locator: role("button", "Save"),
    },
    {
        name: "a resolved node with an empty id",
        method: "DOM.resolveNode",
        change: resolvedNode({ objectId: "" }),
        locator: role("button", "Save"),
    },
    {
        name: "a resolved node with no id",
        method: "DOM.resolveNode",
        change: resolvedNode({}),
        locator: role("button", "Save"),
    },
];

describe("Using the real browser driver", () => {
    let harness: CapabilityHarness;
    let relayed: RelayedDriver;

    before(async () => {
        harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
    });
    after(async () => {
        await harness.close();
    });
    beforeEach(async () => {
        relayed = await startRelayedDriver();
    });

    const onOpenSession = async <Value>(
        path: string,
        act: (session: DriverSession) => Promise<Value>,
    ): Promise<Value> => {
        const opened = await relayed.driver.open(harness.target(TARGET), harness.environment());
        assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
        const session = opened.value;
        try {
            assert.ok(
                (await session.navigate(harness.url(path), scriptsEnabled)).ok,
                `${path} loads`,
            );
            return await act(session);
        } finally {
            await session.close();
            await relayed.relay.close();
        }
    };

    const madeUpHandlesSent = (): readonly unknown[] =>
        relayed.relay.commands().flatMap(handlesIn).filter(isMadeUpHandle);

    for (const { name, change } of [
        { name: "with no result", change: NO_RESULT },
        { name: "with a result that is text", change: TEXT_RESULT },
    ]) {
        describe(`given the browser answers a navigation ${name}`, () => {
            describe("when a plan navigates", () => {
                test("then it should fail as navigation-failed, with no language error", async () => {
                    const navigated = await onOpenSession(PAGE, async (session) => {
                        relayed.relay.tamperWith({ method: "Page.navigate", change });
                        return session.navigate(harness.url(PAGE), scriptsEnabled);
                    });
                    assert.equal(relayed.relay.timesTampered(), 1);
                    assert.ok(!navigated.ok, "the navigation fails");
                    assert.equal(navigated.error.code, "navigation-failed");
                    assert.doesNotMatch(navigated.error.detail, WHAT_A_LANGUAGE_ERROR_SAYS);
                });
            });
        });
    }

    for (const { name, method, change, locator } of UNREADABLE_REPLIES) {
        describe(`given the browser answers ${name}`, () => {
            describe("when a plan reads the element", () => {
                let count: unknown;
                let madeUp: readonly unknown[];
                beforeEach(async () => {
                    count = await onOpenSession(PAGE, async (session) => {
                        relayed.relay.tamperWith({ method, change });
                        return (await session.probe(harness.locator(locator), null)).count;
                    });
                    madeUp = madeUpHandlesSent();
                });

                test("then it should say the page could not be read, and send no made-up handle back", () => {
                    assert.ok(relayed.relay.timesTampered() > 0, "the reply was changed");
                    assert.deepEqual({ count, madeUp }, { count: PAGE_UNREADABLE, madeUp: [] });
                });
            });
        });
    }

    describe("given the browser answers a page's reads with no remote object", () => {
        describe("when a plan reads the page", () => {
            test("then it should fail as unreadable, with no language error", async () => {
                const read = await onOpenSession(PAGE, async (session) => {
                    relayed.relay.tamperWith({
                        method: "Runtime.callFunctionOn",
                        change: NO_REMOTE_OBJECT,
                    });
                    return session.page();
                });
                assert.ok(!read.ok, "the read gave nothing");
                assert.equal(read.error.code, "page-unreadable");
                assert.doesNotMatch(read.error.detail, WHAT_A_LANGUAGE_ERROR_SAYS);
            });
        });
    });

    describe("given the browser answers the accessibility tree with no nodes", () => {
        describe("when a run reads the snapshot", () => {
            test("then it should fail as unreadable, with no language error", async () => {
                const read = await onOpenSession(PAGE, async (session) => {
                    relayed.relay.tamperWith({
                        method: "Accessibility.getFullAXTree",
                        change: { result: {} },
                    });
                    return session.accessibilitySnapshot();
                });
                assert.ok(!read.ok, "the read gave nothing");
                assert.equal(read.error.code, "page-unreadable");
                assert.doesNotMatch(read.error.detail, WHAT_A_LANGUAGE_ERROR_SAYS);
            });
        });
    });

    const isAfterTheMouseRelease = (): boolean =>
        relayed.relay
            .commands()
            .some(
                ({ method, parameters }) =>
                    method === "Input.dispatchMouseEvent" && parameters["type"] === "mouseReleased",
            );

    for (const { name, change } of [
        { name: "no value", change: remoteObject({ type: "undefined" }) },
        { name: "a number", change: remoteObject({ type: "number", value: 7 }) },
        { name: "no remote object", change: NO_REMOTE_OBJECT },
    ]) {
        describe(`given the browser answers the read after a press with ${name}`, () => {
            describe("and a cover takes the press", () => {
                describe("when a plan clicks the button", () => {
                    test("then it should fail as not-actionable, with no language error", async () => {
                        const acted = await onOpenSession(COVERED_PAGE, async (session) => {
                            relayed.relay.tamperWith({
                                method: "Runtime.callFunctionOn",
                                applies: isAfterTheMouseRelease,
                                change,
                            });
                            return session.act(
                                harness.actionStep(click(testId(BUTTON))),
                                allowEveryAction,
                            );
                        });
                        assert.ok(relayed.relay.timesTampered() > 0, "the reply was changed");
                        assert.ok(!acted.ok, "the step fails");
                        assert.equal(acted.error.code, "not-actionable");
                        assert.doesNotMatch(acted.error.detail, WHAT_A_LANGUAGE_ERROR_SAYS);
                    });
                });
            });
        });
    }

    const scriptCall = {
        source: SCRIPT_SOURCE,
        arguments: {},
        timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        maximumResultBytes: 1000,
    };

    for (const { name, applies, change } of [
        { name: "the script's call with no result", applies: isScriptCall, change: NO_RESULT },
        {
            name: "the script's call with no remote object",
            applies: isScriptCall,
            change: NO_REMOTE_OBJECT,
        },
        {
            name: "the script's call with an empty id",
            applies: isScriptCall,
            change: remoteObject({ objectId: "" }),
        },
        {
            name: "the writing of the script's result with no remote object",
            applies: (command: SentCommand) => !isScriptCall(command),
            change: NO_REMOTE_OBJECT,
        },
    ]) {
        describe(`given the browser answers ${name}`, () => {
            describe("when a plan runs a page script", () => {
                test("then it should fail with no language error, and send no made-up handle back", async () => {
                    const ran = await onOpenSession(PAGE, async (session) => {
                        relayed.relay.tamperWith({
                            method: "Runtime.callFunctionOn",
                            applies,
                            change,
                        });
                        return session.runScript(scriptCall);
                    });
                    assert.ok(relayed.relay.timesTampered() > 0, "the reply was changed");
                    assert.ok(!ran.ok, "the script's step fails");
                    assert.doesNotMatch(ran.error.detail, WHAT_A_LANGUAGE_ERROR_SAYS);
                    assert.deepEqual(madeUpHandlesSent(), []);
                });
            });
        });
    }

    describe("given the browser sends a held request's event with no request in it", () => {
        describe("when a plan reads the page afterwards", () => {
            test("then it should go on reading, with nothing thrown out of the driver", async () => {
                const count = await onOpenSession(PAGE, async (session) => {
                    relayed.relay.sendEvent("Fetch.requestPaused", { requestId: "made-up" });
                    return (await session.probe(harness.locator(testId(BUTTON)), null)).count;
                });
                assert.equal(count, 1);
            });
        });
    });
});
