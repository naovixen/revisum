// A page can open a dialog as it loads. Nothing more loads until it is answered, and only a dialog step
// can answer it, so a navigate that waits on for the load would fail the step for a reason the plan could
// have dealt with. It ends at once, saying a dialog holds the page, inside the step's own timeout.
import assert from "node:assert/strict";
import { after, afterEach, before, describe, test } from "node:test";
import type { Session } from "@revisum/engine";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import {
    ACCEPT,
    actionStep,
    allowing,
    failureCode,
} from "#test-support/session-contract/SessionUnderTest.ts";

shareBrowserInThisFile();

const STEP_TIMEOUT_MILLISECONDS = 3000;
// Inside the 10 seconds a navigation is otherwise given to load, with room for a slow machine.
const LONGEST_STEP_MILLISECONDS = 7000;
const TARGET = BrowserTarget.Chrome;
const PAGE = "/alerts-as-it-loads.html";

const ROUTES = new Map<string, FixtureRoute>([
    [
        PAGE,
        () => ({
            headers: { "content-type": "text/html; charset=utf-8" },
            body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Alert</title></head><body>
      <main><p>Before the alert</p></main><script>alert("Welcome");</script>
    </body></html>`,
        }),
    ],
]);

describe("Using the real browser driver", () => {
    let harness: CapabilityHarness;
    let opened: Session[] = [];

    before(async () => {
        harness = await capabilityHarness(STEP_TIMEOUT_MILLISECONDS, ROUTES);
    });
    after(async () => {
        await harness.close();
    });
    afterEach(async () => {
        await Promise.all(opened.map((session) => session.close()));
        opened = [];
    });

    const openSession = async (): Promise<Session> => {
        const session = await harness.open(TARGET);
        opened.push(session);
        return session;
    };

    describe("given a page that alerts while it loads", () => {
        describe("when a step navigates to it", () => {
            test("then it should fail with dialog-open within the step's timeout", async () => {
                const session = await openSession();
                const startedAt = Date.now();
                const navigated = await session.navigate(harness.url(PAGE), scriptsEnabled);
                const elapsed = Date.now() - startedAt;
                assert.equal(failureCode(navigated), "dialog-open");
                assert.ok(elapsed < LONGEST_STEP_MILLISECONDS, `the navigate took ${elapsed} ms`);
            });

            test("then it should still let a dialog step answer it", async () => {
                const session = await openSession();
                await session.navigate(harness.url(PAGE), scriptsEnabled);
                const answered = await session.act(actionStep(ACCEPT), allowing().guard);
                assert.ok(answered.ok, JSON.stringify(answered));
            });
        });
    });
});
