// A download step proves that its click starts a file. A file a page's own timer starts while the
// step waits says nothing about the click, whichever comes first, so the step must not keep it.
// The page's Start button sets the timer in an earlier step, the button under test does nothing,
// and its counter-examples start the file from the click itself.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { outcomes, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import { click, navigate, role, testId, visible } from "#test-support/browser/RawPlan.ts";
import { shareBrowserInThisFile } from "#test-support/browser/ShareBrowserInThisFile.ts";
import { filesHolding } from "#test-support/repository/FilesNamed.ts";
import { download, expectDownload } from "../page-reads/support/PageStatesHarness.ts";
import {
    TARGET,
    htmlPage,
    routedPagesHarness,
} from "../../support/browser/harnesses/RoutedPagesHarness.ts";

shareBrowserInThisFile();

const STEP_TIMEOUT_MILLISECONDS = 4000;
const REPORT_MARKER = "timer-or-click-report-marker";
const DOES_NOTHING = "does-nothing";
const NAME = "report";

const START_THE_FILE = `
  const link = document.createElement('a');
  link.href = '/report.csv';
  link.download = 'report.csv';
  document.body.append(link);
  link.click();`;

const PAGE = `
  <button type="button" data-testid="file-before-the-press">Start, file before the press</button>
  <button type="button" data-testid="file-after-the-press">Start, file after the press</button>
  <button type="button" data-testid="${DOES_NOTHING}">Does nothing</button>
  <button type="button" data-testid="starts-the-file">Starts the file</button>
  <a href="/report.csv" data-testid="link-to-the-file">Link to the file</a>
  <p data-testid="status">Ready</p>
  <script>
    const startTheFile = () => { ${START_THE_FILE} };
    const button = document.querySelector('[data-testid="${DOES_NOTHING}"]');
    // The file starts while the step's wait for its enabled button is under way.
    document.querySelector('[data-testid="file-before-the-press"]').addEventListener('click', () => {
      button.disabled = true;
      setTimeout(startTheFile, 600);
      setTimeout(() => { button.disabled = false; }, 1400);
    });
    // The step arms and clicks well inside this delay, so the file starts after the press.
    document.querySelector('[data-testid="file-after-the-press"]').addEventListener('click', () => {
      setTimeout(startTheFile, 1500);
    });
    document.querySelector('[data-testid="starts-the-file"]').addEventListener('click', startTheFile);
  </script>`;

let harness: BrowserHarness;
before(async () => {
    harness = await routedPagesHarness({
        stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
        routes: new Map([
            ["/start.html", htmlPage(PAGE)],
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
});

const CHECK_THE_FILE = expectDownload(
    NAME,
    { kind: "contentContains", value: REPORT_MARKER },
    "report.holds-marker",
);
const START_PAGE = navigate("/start.html");

describe("Using a run in a real browser", () => {
    for (const { name, startButton } of [
        { name: "before the click is sent", startButton: "file-before-the-press" },
        { name: "after the click is sent", startButton: "file-after-the-press" },
    ]) {
        describe(`given a page timer that starts a file ${name}`, () => {
            describe("and a download step clicks a button that does nothing", () => {
                describe("when the run ends", () => {
                    test("then it should fail the step with unsupported-step and keep no file", async () => {
                        const { result, startedAt } = await harness.runSteps(TARGET, [
                            START_PAGE,
                            click(testId(startButton)),
                            download(NAME, testId(DOES_NOTHING)),
                            CHECK_THE_FILE,
                        ]);
                        assert.deepEqual(
                            outcomes(result),
                            [
                                [0, "passed", undefined],
                                [1, "passed", undefined],
                                [2, "failed", "unsupported-step"],
                                [3, "skipped", undefined],
                            ],
                            JSON.stringify(result.steps),
                        );
                        assert.equal(result.state, "Failed");
                        assert.deepEqual(filesHolding(REPORT_MARKER, startedAt), []);
                    });
                });
            });
        });
    }

    describe("given no timer on the page", () => {
        describe("and a download step clicks a button that does nothing", () => {
            describe("when the run ends", () => {
                test("then it should fail the step with no-download", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        START_PAGE,
                        download(NAME, testId(DOES_NOTHING)),
                        visible(testId("status"), "status.shown"),
                    ]);
                    assert.deepEqual(
                        outcomes(result),
                        [
                            [0, "passed", undefined],
                            [1, "failed", "no-download"],
                            [2, "skipped", undefined],
                        ],
                        JSON.stringify(result.steps),
                    );
                });
            });
        });
    });

    for (const { name, locator } of [
        { name: "a button whose handler starts the file", locator: testId("starts-the-file") },
        { name: "a link to the file", locator: role("link", "Link to the file") },
    ]) {
        describe(`given ${name}`, () => {
            describe("when a download step clicks it", () => {
                test("then it should pass the step and keep the file", async () => {
                    const { result } = await harness.runSteps(TARGET, [
                        START_PAGE,
                        download(NAME, locator),
                        CHECK_THE_FILE,
                    ]);
                    assert.equal(result.state, "Passed", JSON.stringify(result.steps));
                });
            });
        });
    }
});
