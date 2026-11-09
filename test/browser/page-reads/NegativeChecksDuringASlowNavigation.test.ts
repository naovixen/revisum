// A check that an element is absent passes when nothing matches, and the page a click is leaving may
// never have had that element. So while the click's navigation is still under way a first look proves
// nothing about the page the click leads to. The server here holds its answer well past the check's
// first look, then answers or destroys the connection, so what the check finds does not depend on
// the machine's speed: a look that came too late would only ever see the page the plan meant.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import type { BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { click, navigate, role, testId, type JsonRecord } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { assertStepFailedWith } from "../../support/browser/harnesses/AssertStepFailedWith.ts";
import { TARGET, htmlPage, routedPagesHarness } from "../../support/browser/harnesses/RoutedPagesHarness.ts";

shareBrowserInThisFile();

const HOLD_MILLISECONDS = 500;
const STEP_TIMEOUT_MILLISECONDS = 2500;
const CHECK_STEP = 2;
const ORDER_ERROR = testId("order-error");

const FAILS_SLOWLY_LINK = "Go to the page that fails slowly";
const SHOWS_ERROR_SLOWLY_LINK = "Go to the slow page showing the error";
const LOADS_SLOWLY_LINK = "Go to the slow page without the error";
const FAILS_SLOWLY_PATH = "/orders/connection-lost";
const SHOWS_ERROR_PATH = "/orders/shows-error";
const LOADS_PATH = "/orders/loaded";

const NEGATIVE_CHECKS: readonly { readonly name: string; readonly assertion: JsonRecord }[] = [
    { name: "an absent", assertion: { kind: "absent" } },
    { name: "a hidden", assertion: { kind: "hidden" } },
    { name: "a countEquals 0", assertion: { kind: "countEquals", value: 0 } },
];

const pageHtml = (body: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Orders</title></head><body><main>${body}</main></body></html>`;

// Holds every request, then answers it as its path says.
function startSlowServer(): Promise<Server> {
    const server = createServer((request, response) => {
        setTimeout(() => {
            if (request.url === FAILS_SLOWLY_PATH) {
                request.socket.destroy();
                return;
            }
            const body =
                request.url === SHOWS_ERROR_PATH
                    ? `<p data-testid="order-error">Payment declined</p>`
                    : "<h1>Your orders</h1>";
            response.writeHead(200, {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
            });
            response.end(pageHtml(body));
        }, HOLD_MILLISECONDS);
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve(server);
        });
    });
}

let slowServer: Server;
let harness: BrowserHarness;

before(async () => {
    slowServer = await startSlowServer();
    const { port } = slowServer.address() as AddressInfo;
    const slowOrigin = `http://127.0.0.1:${port}`;
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        otherOrigins: [slowOrigin],
        routes: new Map([
            [
                "/start.html",
                htmlPage(`
                  <a href="${slowOrigin}${FAILS_SLOWLY_PATH}">${FAILS_SLOWLY_LINK}</a>
                  <a href="${slowOrigin}${SHOWS_ERROR_PATH}">${SHOWS_ERROR_SLOWLY_LINK}</a>
                  <a href="${slowOrigin}${LOADS_PATH}">${LOADS_SLOWLY_LINK}</a>`),
            ],
        ]),
    });
});
after(async () => {
    await harness.close();
    slowServer.closeAllConnections();
    await new Promise((resolve) => slowServer.close(resolve));
});

const clickThenCheck = async (link: string, assertion: JsonRecord) =>
    (
        await harness.runSteps(TARGET, [
            navigate("/start.html"),
            click(role("link", link)),
            {
                type: "expect",
                locator: ORDER_ERROR,
                assert: assertion,
                criterionId: "orders.error-gone",
            },
        ])
    ).result;

describe("Using a run in a real browser", () => {
    for (const { name, assertion } of NEGATIVE_CHECKS) {
        describe("given a click on a link whose server holds its answer and then destroys the connection", () => {
            describe(`when ${name} check of an element the first page never had runs`, () => {
                test("then it should fail with navigation-failed", async () => {
                    const result = await clickThenCheck(FAILS_SLOWLY_LINK, assertion);
                    assertStepFailedWith(result, CHECK_STEP, "navigation-failed");
                });
            });
        });

        describe("given a click on a link whose server holds a page that shows the element", () => {
            describe(`when ${name} check of the element runs`, () => {
                test("then it should fail with assertion-failed", async () => {
                    const result = await clickThenCheck(SHOWS_ERROR_SLOWLY_LINK, assertion);
                    assertStepFailedWith(result, CHECK_STEP, "assertion-failed");
                });
            });
        });

        describe("given a click on a link whose server holds a page without the element", () => {
            describe(`when ${name} check of the element runs`, () => {
                test("then it should pass", async () => {
                    const result = await clickThenCheck(LOADS_SLOWLY_LINK, assertion);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });
    }
});
