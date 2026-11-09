// A popup or a download that no step asked for fails the step that was under way, so a run cannot
// pass as if nothing had opened. A download begins only when its server answers, which may be long
// after the click, and a page may open either while the run navigates or checks, not only during an
// action. The server here holds every answer back for a moment, and each page's own timers fire
// while the next step is under way.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import {
    outcomes,
    type BrowserHarness,
    type BrowserRunOptions,
} from "#test-support/browser/BrowserHarness.ts";
import { driversOnFreshBrowsers } from "#test-support/browser/driver/CreateBrowserDriver.ts";
import {
    click,
    label,
    navigate,
    press,
    role,
    testId,
    textEquals,
    visible,
    type JsonRecord,
} from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { filesHolding } from "#test-support/repository/FilesNamed.ts";
import { download } from "../page-reads/support/PageStatesHarness.ts";
import {
    TARGET,
    htmlPage,
    routedPagesHarness,
} from "../../support/browser/harnesses/RoutedPagesHarness.ts";
import { StepOutcome } from "@revisum/contracts";

shareBrowserInThisFile();

const STEP_TIMEOUT_MILLISECONDS = 4000;
// Far longer than the frames a step's action waits for, and far shorter than the step's timeout.
const HOLD_MILLISECONDS = 1000;

const ATTACHMENT_PATH = "/attachment";
const SLOW_PAGE_PATH = "/slow-page";
const STATUS = testId("status");
const SEARCH_FIELD = "Search";
const REPORT_MARKER = "opening-outside-an-action-report-marker";

const ATTACHMENT_REQUESTS = [
    {
        name: "a click on a link",
        step: click(role("link", "Export by link")),
    },
    {
        name: "a click on a button whose script moves the page",
        step: click(role("button", "Export by script")),
    },
    {
        name: "a click on a form's button",
        step: click(role("button", "Export by form")),
    },
    {
        name: "an Enter press in a form",
        step: press(label(SEARCH_FIELD), "Enter"),
    },
];

const NAVIGATIONS_TO_A_SLOW_PAGE = [
    {
        name: "a click on a link",
        step: click(role("link", "Next by link")),
    },
    {
        name: "a click on a form's button",
        step: click(role("button", "Next by form")),
    },
];

// A timer that starts a download the way a page's script does: a link nobody can see, clicked.
const START_A_DOWNLOAD = `
  const link = document.createElement('a');
  link.href = '/report.csv';
  link.download = 'report.csv';
  document.body.append(link);
  link.click();`;

const OPEN_A_POPUP = `window.open('about:blank', '_blank');`;

// Each button opens something after a moment, and the page says Done a moment later, so a check
// waiting for Done is under way when it opens. The press is what lets the browser open a popup.
const afterAMoment = (id: string, action: string): string => `
  <button type="button" data-testid="${id}">${id}</button>
  <script>
    document.querySelector('[data-testid="${id}"]').addEventListener('click', () => {
      setTimeout(() => { ${action} }, 300);
      setTimeout(() => { document.querySelector('[data-testid="status"]').textContent = 'Done'; }, 900);
    });
  </script>`;

const whileParsing = (address: string): string => `<script>location.href = ${address};</script>`;

const atLoadEvent = (address: string): string =>
    `<script>addEventListener('load', () => { location.href = ${address}; });</script>`;

const startPage = (heldOrigin: string): string => `
  <a href="${heldOrigin}${ATTACHMENT_PATH}?by=link">Export by link</a>
  <button type="button" onclick="location.href='${heldOrigin}${ATTACHMENT_PATH}?by=script'">Export by script</button>
  <form action="${heldOrigin}${ATTACHMENT_PATH}"><button>Export by form</button></form>
  <form action="${heldOrigin}${ATTACHMENT_PATH}"><label>${SEARCH_FIELD}<input name="q"></label></form>
  <a href="${heldOrigin}${SLOW_PAGE_PATH}">Next by link</a>
  <form action="${heldOrigin}${SLOW_PAGE_PATH}"><button>Next by form</button></form>
  <p data-testid="status">Ready</p>
  ${afterAMoment("popup-soon", OPEN_A_POPUP)}
  ${afterAMoment("download-soon", START_A_DOWNLOAD)}
  ${afterAMoment("nothing-soon", "")}`;

let harness: BrowserHarness;
let heldServer: Server;
let heldOrigin: string;

before(async () => {
    heldServer = createServer((request, response) => {
        const path = new URL(request.url ?? "/", "http://localhost").pathname;
        setTimeout(() => {
            if (path === ATTACHMENT_PATH) {
                response.writeHead(200, {
                    "content-type": "text/csv",
                    "content-disposition": 'attachment; filename="report.csv"',
                    "cache-control": "no-store",
                });
                response.end("name\nSlow report\n");
                return;
            }
            response.writeHead(200, {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
            });
            response.end(
                '<!doctype html><html lang="en"><head><title>Slow</title></head><body><main><p data-testid="status">Arrived</p></main></body></html>',
            );
        }, HOLD_MILLISECONDS);
    });
    await new Promise<void>((resolve) => heldServer.listen(0, "127.0.0.1", resolve));
    heldOrigin = `http://127.0.0.1:${(heldServer.address() as AddressInfo).port}`;
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        otherOrigins: [heldOrigin],
        routes: new Map([
            ["/start.html", htmlPage(startPage(heldOrigin))],
            [
                "/download-as-it-loads.html",
                htmlPage(`<p data-testid="status">Ready</p><script>${START_A_DOWNLOAD}</script>`),
            ],
            ["/attachment-at-load-event.html", htmlPage(atLoadEvent("'/report.csv'"))],
            ["/attachment-while-parsing.html", htmlPage(whileParsing("'/report.csv'"))],
            ["/next-page-at-load-event.html", htmlPage(atLoadEvent("'/plain.html'"))],
            ["/next-page-while-parsing.html", htmlPage(whileParsing("'/plain.html'"))],
            ["/plain.html", htmlPage('<p data-testid="status">Ready</p>')],
            [
                "/report.csv",
                () => ({
                    headers: {
                        "content-type": "text/csv",
                        "content-disposition": 'attachment; filename="report.csv"',
                    },
                    body: `name\n${REPORT_MARKER}\n`,
                }),
            ],
        ]),
    });
});

after(async () => {
    await harness.close();
    heldServer.closeAllConnections();
    await new Promise((resolve) => heldServer.close(resolve));
});

const START = navigate("/start.html");
const STATUS_SHOWN = visible(STATUS, "status.shown");
const DONE = textEquals(STATUS, "Done", "status.done");

const BROWSERS_OF_A_RUN = [
    { name: "a shared browser", runOptions: () => ({}) },
    {
        name: "a browser launched for the run",
        runOptions: () => ({ drivers: driversOnFreshBrowsers([TARGET]) }),
    },
];

const assertOutcomes = async (
    steps: readonly JsonRecord[],
    expected: readonly (readonly [number, string, string | undefined])[],
    options: BrowserRunOptions = {},
): Promise<void> => {
    const { result } = await harness.runSteps(TARGET, steps, options);
    assert.deepEqual(outcomes(result), expected, JSON.stringify(result.steps));
    assert.equal(result.state, "Failed");
};

// The browser reports a download some time after the page's script starts it, which may be after
// the page has loaded, so which step it lands on is the browser's timing and not a promise. What
// must hold is that the run fails for it. The run's own folder goes when the session closes, so the
// disk is searched just before that as well as after it.
const assertRunFailsAndKeepsNoFile = async (
    steps: readonly JsonRecord[],
): Promise<readonly (string | undefined)[]> => {
    const startedAt = Date.now();
    let filesAtClose: readonly string[] | undefined;
    const { result } = await harness.runSteps(TARGET, steps, {
        read: [],
        beforePageRead: () => {
            filesAtClose = filesHolding(REPORT_MARKER, startedAt);
            return Promise.resolve();
        },
    });
    assert.equal(result.state, "Failed", JSON.stringify(result.steps));
    assert.deepEqual(filesAtClose, [], "no file was kept while the session was open");
    assert.deepEqual(filesHolding(REPORT_MARKER, startedAt), [], "no file was left after the run");
    return result.steps
        .filter((step) => step.outcome === StepOutcome.Failed)
        .map((step) => step.code);
};

const assertRunFailsForTheOpeningAndKeepsNoFile = async (
    steps: readonly JsonRecord[],
): Promise<void> => {
    assert.deepEqual(await assertRunFailsAndKeepsNoFile(steps), ["unsupported-step"]);
};

describe("Using a run in a real browser", () => {
    for (const { name, step } of ATTACHMENT_REQUESTS) {
        for (const { name: browser, runOptions } of BROWSERS_OF_A_RUN) {
            describe(`given ${name} that asks for an attachment its server answers late`, () => {
                describe(`and the run on ${browser}`, () => {
                    describe("when a check follows it", () => {
                        test("then it should fail that step with unsupported-step and skip the check", async () => {
                            await assertOutcomes(
                                [START, step, STATUS_SHOWN],
                                [
                                    [0, "passed", undefined],
                                    [1, "failed", "unsupported-step"],
                                    [2, "skipped", undefined],
                                ],
                                runOptions(),
                            );
                        });
                    });
                });
            });
        }
    }

    for (const { name, step } of NAVIGATIONS_TO_A_SLOW_PAGE) {
        describe(`given ${name} that asks for a page its server answers late`, () => {
            describe("when a check of the new page follows", () => {
                test("then it should pass the run", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        START,
                        step,
                        textEquals(STATUS, "Arrived", "status.arrived"),
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });
    }

    describe("given an attachment its server answers late", () => {
        describe("when a download step clicks the link to it", () => {
            test("then it should pass the step and keep the file", async () => {
                const { result } = await harness.runSteps(TARGET, [
                    START,
                    download("report", role("link", "Export by link")),
                    {
                        type: "expectDownload",
                        download: "report",
                        assert: { kind: "fileNameEquals", value: "report.csv" },
                        criterionId: "report.saved",
                    },
                ]);
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });

    for (const { name, button } of [
        { name: "a popup", button: "popup-soon" },
        { name: "a download", button: "download-soon" },
    ]) {
        describe(`given a page timer that opens ${name} while a check waits`, () => {
            describe("when the check would otherwise pass", () => {
                test("then it should fail the check with unsupported-step", async () => {
                    await assertOutcomes(
                        [START, click(testId(button)), DONE],
                        [
                            [0, "passed", undefined],
                            [1, "passed", undefined],
                            [2, "failed", "unsupported-step"],
                        ],
                    );
                });
            });
        });
    }

    describe("given a page timer that opens nothing while a check waits", () => {
        describe("when the check would pass", () => {
            test("then it should pass the run", async () => {
                const { result } = await harness.runSteps(TARGET, [
                    START,
                    click(testId("nothing-soon")),
                    DONE,
                ]);
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });

    describe("given a page that starts a download as it loads", () => {
        describe("and a check follows the navigate step that loads it", () => {
            describe("when the run ends", () => {
                test("then it should fail with unsupported-step and keep no file", async () => {
                    await assertRunFailsForTheOpeningAndKeepsNoFile([
                        navigate("/download-as-it-loads.html"),
                        STATUS_SHOWN,
                    ]);
                });
            });
        });

        describe("and the navigate step that loads it is the plan's last step", () => {
            describe("when the run ends", () => {
                test("then it should fail with unsupported-step and keep no file", async () => {
                    await assertRunFailsForTheOpeningAndKeepsNoFile([
                        navigate("/plain.html"),
                        STATUS_SHOWN,
                        navigate("/download-as-it-loads.html"),
                    ]);
                });
            });
        });
    });

    describe("given a page whose script moves it to an attachment at its load event", () => {
        describe("and the navigate step that loads it is the plan's last step", () => {
            describe("when the run ends", () => {
                test("then it should fail with unsupported-step and keep no file", async () => {
                    await assertRunFailsForTheOpeningAndKeepsNoFile([
                        navigate("/plain.html"),
                        STATUS_SHOWN,
                        navigate("/attachment-at-load-event.html"),
                    ]);
                });
            });
        });
    });

    describe("given a page whose script moves it to an attachment while it is parsed", () => {
        describe("and the navigate step that loads it is the plan's last step", () => {
            describe("when the run ends", () => {
                test("then it should fail and keep no file", async () => {
                    await assertRunFailsAndKeepsNoFile([
                        navigate("/plain.html"),
                        STATUS_SHOWN,
                        navigate("/attachment-while-parsing.html"),
                    ]);
                });
            });
        });
    });

    for (const { name, path } of [
        { name: "at its load event", path: "/next-page-at-load-event.html" },
        { name: "while it is parsed", path: "/next-page-while-parsing.html" },
    ]) {
        describe(`given a page whose script moves it to an ordinary page ${name}`, () => {
            describe("and the navigate step that loads it is the plan's last step", () => {
                describe("when the run ends", () => {
                    test("then it should pass the run", async () => {
                        const { result } = await harness.runSteps(TARGET, [
                            navigate("/plain.html"),
                            STATUS_SHOWN,
                            navigate(path),
                        ]);
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });

            describe("and a check of the ordinary page follows", () => {
                describe("when the run ends", () => {
                    test("then it should pass the run", async () => {
                        const { result } = await harness.runSteps(TARGET, [
                            navigate(path),
                            STATUS_SHOWN,
                        ]);
                        assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                    });
                });
            });
        });
    }

    describe("given a page that starts nothing as it loads", () => {
        describe("when a navigate step loads it", () => {
            test("then it should pass the run", async () => {
                const { result } = await harness.runSteps(TARGET, [
                    navigate("/plain.html"),
                    STATUS_SHOWN,
                ]);
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });

    describe("given a page timer that opens a popup while a navigate waits for a slow page", () => {
        describe("when the navigate ends", () => {
            test("then it should fail the navigate with unsupported-step", async () => {
                await assertOutcomes(
                    [
                        START,
                        click(testId("popup-soon")),
                        navigate(`${heldOrigin}${SLOW_PAGE_PATH}`),
                        STATUS_SHOWN,
                    ],
                    [
                        [0, "passed", undefined],
                        [1, "passed", undefined],
                        [2, "failed", "unsupported-step"],
                        [3, "skipped", undefined],
                    ],
                );
            });
        });
    });

    describe("given a page timer that opens nothing while a navigate waits for a slow page", () => {
        describe("when the navigate ends", () => {
            test("then it should pass the run", async () => {
                const { result } = await harness.runSteps(TARGET, [
                    START,
                    click(testId("nothing-soon")),
                    navigate(`${heldOrigin}${SLOW_PAGE_PATH}`),
                    textEquals(STATUS, "Arrived", "status.arrived"),
                ]);
                assert.equal(result.state, "Passed", JSON.stringify(result.steps));
            });
        });
    });
});
