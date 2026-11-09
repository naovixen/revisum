// What a capture must hide may sit in a frame of the page: masking only the top document would leave
// it on screen. A frame the driver cannot reach cannot be masked, so a capture over it must fail
// rather than show what it may hold. All values here are made up for tests.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { Session } from "@revisum/engine";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import {
    capabilityHarness,
    ownDriverFor,
    type CapabilityHarness,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import {
    startFixtureServer,
    type FixtureRoute,
    type FixtureServer,
} from "#test-support/builders/FixtureServer.ts";
import { decodePng } from "#test-support/builders/DecodePng.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";
import { failureCode, locatorOf } from "#test-support/session-contract/SessionUnderTest.ts";

shareBrowserInThisFile();

const STEP_TIMEOUT_MILLISECONDS = 4000;
const TARGET = BrowserTarget.Chrome;
const FIRST_VALUE = "test-only-AAAAAAAAAAAA";
const SECOND_VALUE = "test-only-WWWWWWWWWWWW";
const MASK = [".ssn"];

const html = (body: string): ReturnType<FixtureRoute> => ({
    headers: { "content-type": "text/html; charset=utf-8", "origin-agent-cluster": "?1" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Page</title></head><body><main>${body}</main></body></html>`,
});

const framedInput = (value: string): string =>
    `<iframe title="Details" data-testid="details" srcdoc="<input class='ssn' value='${value}' style='width:500px;height:60px;font-size:32px'>" style="width:600px;height:120px;border:0"></iframe>`;

const pageRoute: FixtureRoute = ({ query }) => html(framedInput(query.get("value") ?? ""));

describe("Using a capture in a real browser", () => {
    let harness: CapabilityHarness;
    let otherOrigin: FixtureServer;

    before(async () => {
        otherOrigin = await startFixtureServer(
            join(FIXTURES, "sites", "capability-app"),
            undefined,
            new Map<string, FixtureRoute>([
                ["/frame.html", () => html("<input class=ssn value=held>")],
            ]),
        );
        const elsewhere = (): ReturnType<FixtureRoute> =>
            html(
                `<iframe title="Elsewhere" data-testid="elsewhere" src="${otherOrigin.origin}/frame.html" style="width:600px;height:120px;border:0"></iframe>`,
            );
        harness = await capabilityHarness(
            STEP_TIMEOUT_MILLISECONDS,
            new Map<string, FixtureRoute>([
                ["/framed.html", pageRoute],
                ["/elsewhere.html", elsewhere],
            ]),
        );
    });
    after(async () => {
        await harness.close();
        await otherOrigin.close();
    });

    const onSession = async <Answer>(
        path: string,
        use: (session: Session) => Promise<Answer>,
        allowedOrigin?: string,
    ): Promise<Answer> => {
        const environment = harness.environment();
        const opened = await ownDriverFor(TARGET).open(harness.target(TARGET), {
            ...environment,
            allowedOrigins:
                allowedOrigin === undefined
                    ? environment.allowedOrigins
                    : [...environment.allowedOrigins, allowedOrigin],
        });
        assert.ok(opened.ok, `the session opens: ${JSON.stringify(opened)}`);
        const session = opened.value;
        try {
            const navigated = await session.navigate(harness.url(path), scriptsEnabled);
            assert.ok(navigated.ok, JSON.stringify(navigated));
            return await use(session);
        } finally {
            await session.close().catch(() => undefined);
        }
    };

    const pixelsFor = async (value: string, mask: readonly string[]): Promise<Uint8Array> =>
        onSession(`/framed.html?value=${value}`, async (session) => {
            const shot = await session.screenshot(mask);
            assert.ok(shot.ok, JSON.stringify(shot));
            return decodePng(shot.value).data;
        });

    const differingBytes = (first: Uint8Array, second: Uint8Array): number => {
        assert.equal(first.length, second.length, "the two captures have the same size");
        return first.filter((byte, index) => byte !== second[index]).length;
    };

    describe("given a value in a same-process framed document that a mask names", () => {
        describe("when the page is captured with two different values", () => {
            test("then it should show the same pixels", async () => {
                const first = await pixelsFor(FIRST_VALUE, MASK);
                const second = await pixelsFor(SECOND_VALUE, MASK);
                assert.equal(differingBytes(first, second), 0);
            });
        });
    });

    describe("given the same framed document with no mask", () => {
        describe("when the page is captured with two different values", () => {
            test("then it should show the difference", async () => {
                const first = await pixelsFor(FIRST_VALUE, []);
                const second = await pixelsFor(SECOND_VALUE, []);
                assert.ok(differingBytes(first, second) > 0, "the captures are identical");
            });
        });
    });

    describe("given a frame the driver cannot reach", () => {
        describe("when the page is captured with a mask", () => {
            test("then it should fail the capture", async () => {
                const outcome = await onSession(
                    "/elsewhere.html",
                    async (session) => {
                        const entered = await session.frame(
                            locatorOf({ by: "testId", testId: "elsewhere" }),
                        );
                        assert.equal(failureCode(entered), "unsupported-step");
                        return session.screenshot(MASK);
                    },
                    otherOrigin.origin,
                );
                assert.equal(outcome.ok, false, "a capture was taken over a frame out of reach");
            });
        });
    });
});
