// A step has one timeout, whatever it spends the time on. A navigate that loads and then never settles
// has its effect unproved, so it ends as a timeout, as an action does; a selector check that takes most
// of the step leaves only what is left of it to wait for the element, so no step reaches about twice
// its timeout. Everything a step asks the page, not only the wait for its element, runs under that one
// deadline: a command that never answers ends the step near its timeout, whichever command it was, and
// never takes a command's own far longer limit. Time here is mock time, so a step that waits out its
// timeout costs nothing.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type {
    DocumentSession,
    DriverError,
    PerformableAction,
    ResolvedDownloadStep,
    ResolvedLocator,
    Result,
} from "@revisum/engine";
import { navigate } from "#test-support/browser/RawPlan.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import {
    fakeDocumentPorts,
    type FakeDocumentOptions,
} from "#test-support/fakes/session/FakeDocumentPorts.ts";
import { fakeDownloadCapture } from "#test-support/fakes/session/FakeDownloadCapture.ts";
import {
    elementPageOperations,
    FAKE_PAGE_ELEMENT,
} from "#test-support/fakes/session/ElementPageOperations.ts";
import { inMockTime } from "#test-support/InMockTime.ts";
import { performableActionOf, resolvedDownloadOf } from "#test-support/PerformableActionOf.ts";
import { allowing, failureCode } from "#test-support/session-contract/SessionUnderTest.ts";
import { whatAClickActivates } from "../../../../packages/driver-cdp/src/in-page/elements/Actionability.ts";
import { guardDetails } from "../../../../packages/driver-cdp/src/in-page/elements/GuardDetails.ts";
import {
    linkTargetList,
    pageInfo,
} from "../../../../packages/driver-cdp/src/in-page/document/PageInfo.ts";
import { structuralSelectorValidity } from "../../../../packages/driver-cdp/src/in-page/elements/StructuralSelectorValidity.ts";
import { accepted, parserFor, planOf } from "../../engine/run/values/examples/RunPlan.ts";
import { unsafeSection } from "../../engine/plan/unsafe-features/examples/UnsafePlan.ts";

const STEP_TIMEOUT_MILLISECONDS = 2000;
// A selector check that leaves almost none of the step for the wait.
const SELECTOR_CHECK_MILLISECONDS = 1800;
// One timeout, a poll and a little: far short of the 3800 ms a second full wait would reach.
const LONGEST_STEP_MILLISECONDS = 2600;

const NEVER = (): Promise<never> =>
    new Promise(() => {
        // A page that never answers.
    });

const MISSING = { by: "css", selector: "#not-on-the-page" };
const BUTTON = { by: "css", selector: "#go" };

const FIXTURE = "note.txt";
const MAXIMUM_BYTES = 1024;
const parsePlan = parserFor({
    fixtures: [FIXTURE],
    unsafeFeatures: unsafeSection(["css-locator"]),
});

const parsedStep = (raw: Readonly<Record<string, unknown>>) => {
    const [, step] = accepted(parsePlan, planOf([navigate("/"), raw])).steps;
    assert.ok(step !== undefined, JSON.stringify(raw));
    return step;
};

// The step as the engine would hand it to a driver, with a CSS locator a project has allowed.
function performableStep(raw: Readonly<Record<string, unknown>>): PerformableAction {
    const step = parsedStep(raw);
    assert.ok(
        step.type === "upload" ||
            step.type === "fill" ||
            step.type === "click" ||
            step.type === "dialog",
        JSON.stringify(step),
    );
    return performableActionOf(step);
}

function downloadOf(locator: Readonly<Record<string, unknown>>): ResolvedDownloadStep {
    const step = parsedStep({ type: "download", name: "report", locator });
    assert.ok(step.type === "download", JSON.stringify(step));
    return resolvedDownloadOf(step);
}

function locatorOf(locator: Readonly<Record<string, unknown>>): ResolvedLocator {
    const action = performableStep({ type: "click", locator });
    assert.ok(action.type === "click", JSON.stringify(action));
    return action.locator;
}

const ELEMENT_ACTIONS: readonly {
    readonly name: string;
    readonly action: () => PerformableAction;
}[] = [
    {
        name: "an upload",
        action: () => performableStep({ type: "upload", locator: MISSING, fixture: FIXTURE }),
    },
    {
        name: "a fill",
        action: () => performableStep({ type: "fill", locator: MISSING, value: "text" }),
    },
    {
        name: "a click",
        action: () => performableStep({ type: "click", locator: MISSING }),
    },
];

const documentOn = (options: FakeDocumentOptions): DocumentSession =>
    fakeDocumentPorts({ timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS, ...options });

// A page whose selector check takes most of the step, and where the element is never found.
const documentWithASlowSelectorCheck = (options: FakeDocumentOptions = {}): DocumentSession =>
    documentOn({
        operations: {
            callForString: () =>
                new Promise((resolve) => {
                    setTimeout(resolve, SELECTOR_CHECK_MILLISECONDS, "valid");
                }),
        },
        ...options,
    });

const clickOn = (document: DocumentSession) =>
    document.act(performableStep({ type: "click", locator: BUTTON }), allowing().guard);
const fillOn = (document: DocumentSession) =>
    document.act(
        performableStep({ type: "fill", locator: BUTTON, value: "text" }),
        allowing().guard,
    );
const downloadOn = (document: DocumentSession) =>
    document.download(downloadOf(BUTTON), MAXIMUM_BYTES, allowing().guard);
const dialogAnswerOn = (document: DocumentSession) =>
    document.act(performableStep({ type: "dialog", action: "accept" }), allowing().guard);

const STALLED_ACTIONS: readonly {
    readonly name: string;
    readonly run: () => Promise<Result<unknown, DriverError>>;
}[] = [
    {
        name: "a click whose guard details are never read",
        run: () =>
            clickOn(documentOn({ operations: elementPageOperations([[guardDetails, NEVER]]) })),
    },
    {
        name: "a click whose role and name are never read",
        run: () =>
            clickOn(documentOn({ operations: { ...elementPageOperations(), roleAndName: NEVER } })),
    },
    {
        name: "a click whose activated elements are never read",
        run: () =>
            clickOn(
                documentOn({
                    operations: {
                        ...elementPageOperations(),
                        callForElements: (pageFunction) =>
                            pageFunction === whatAClickActivates
                                ? NEVER()
                                : Promise.resolve([FAKE_PAGE_ELEMENT]),
                    },
                }),
            ),
    },
    {
        name: "a fill whose guard details are never read",
        run: () =>
            fillOn(documentOn({ operations: elementPageOperations([[guardDetails, NEVER]]) })),
    },
    {
        name: "a download whose selector check never answers",
        run: () =>
            downloadOn(
                documentOn({
                    operations: elementPageOperations([[structuralSelectorValidity, NEVER]]),
                    downloads: fakeDownloadCapture().capture,
                }),
            ),
    },
    {
        name: "a download whose frame is never read before the press",
        run: () =>
            downloadOn(
                documentOn({
                    operations: { ...elementPageOperations(), frameId: NEVER },
                    downloads: fakeDownloadCapture().capture,
                }),
            ),
    },
    {
        name: "a frame step whose selector check never answers",
        run: () =>
            documentOn({
                operations: elementPageOperations([[structuralSelectorValidity, NEVER]]),
            }).frame(locatorOf(BUTTON)),
    },
    {
        name: "a frame step whose frame document never answers",
        run: () =>
            documentOn({
                operations: elementPageOperations(),
                hitChecks: { frame: NEVER },
            }).frame(locatorOf(BUTTON)),
    },
    {
        name: "a dialog step whose answer never lands",
        run: () =>
            dialogAnswerOn(
                documentOn({
                    events: { openDialog: () => "Are you sure?", answerDialog: NEVER },
                }),
            ),
    },
];

const BROWSER_ERROR_PAGE_REPORT = JSON.stringify({
    url: "chrome-error://chromewebdata/",
    title: "",
    meta: [],
    canonicalUrl: null,
});

const STALLED_READS: readonly {
    readonly name: string;
    readonly run: () => Promise<Result<unknown, unknown>>;
}[] = [
    {
        name: "an accessibility snapshot",
        run: () => documentOn({ operations: { accessibilityTree: NEVER } }).accessibilitySnapshot(),
    },
    {
        name: "a read of the link targets",
        run: () =>
            documentOn({
                operations: elementPageOperations([[linkTargetList, NEVER]]),
            }).linkTargets(),
    },
    {
        name: "the address of a page the browser could not show",
        run: () =>
            documentOn({
                operations: {
                    ...elementPageOperations([
                        [pageInfo, () => Promise.resolve(BROWSER_ERROR_PAGE_REPORT)],
                    ]),
                    unreachableUrl: NEVER,
                },
            }).page(),
    },
];

describe("Using a document's ports", () => {
    for (const { name, action } of ELEMENT_ACTIONS) {
        describe(`given ${name} whose selector check takes most of the step`, () => {
            describe("and an element that is never found", () => {
                describe("when it runs", () => {
                    test("then it should end not-found within the step's one deadline", async (context) => {
                        const { value, elapsed } = await inMockTime(context, () =>
                            documentWithASlowSelectorCheck().act(action(), allowing().guard),
                        );
                        assert.equal(failureCode(value), "not-found");
                        assert.ok(
                            elapsed <= LONGEST_STEP_MILLISECONDS,
                            `the step took ${elapsed} ms of mock time`,
                        );
                    });
                });
            });
        });
    }

    describe("given a frame step whose selector check takes most of the step", () => {
        describe("and an element that is never found", () => {
            describe("when it runs", () => {
                test("then it should end not-found within the step's one deadline", async (context) => {
                    const { value, elapsed } = await inMockTime(context, () =>
                        documentWithASlowSelectorCheck().frame(locatorOf(MISSING)),
                    );
                    assert.equal(failureCode(value), "not-found");
                    assert.ok(
                        elapsed <= LONGEST_STEP_MILLISECONDS,
                        `the step took ${elapsed} ms of mock time`,
                    );
                });
            });
        });
    });

    describe("given a download whose selector check takes most of the step", () => {
        describe("and an element that is never found", () => {
            describe("when it runs", () => {
                test("then it should fail within the step's one deadline", async (context) => {
                    const { value, elapsed } = await inMockTime(context, () =>
                        downloadOn(
                            documentWithASlowSelectorCheck({
                                downloads: fakeDownloadCapture().capture,
                            }),
                        ),
                    );
                    assert.equal(value.ok, false, JSON.stringify(value));
                    assert.ok(
                        elapsed <= LONGEST_STEP_MILLISECONDS,
                        `the step took ${elapsed} ms of mock time`,
                    );
                });
            });
        });
    });

    for (const { name, run } of STALLED_ACTIONS) {
        describe(`given ${name}`, () => {
            describe("when it runs", () => {
                test("then it should end as a timeout within the step's one deadline", async (context) => {
                    const { value, elapsed } = await inMockTime(context, run);
                    assert.equal(failureCode(value), "timeout");
                    assert.ok(
                        elapsed <= LONGEST_STEP_MILLISECONDS,
                        `the step took ${elapsed} ms of mock time`,
                    );
                });
            });
        });
    }

    for (const { name, run } of STALLED_READS) {
        describe(`given ${name} that never answers`, () => {
            describe("when it is asked for", () => {
                test("then it should fail within the step's one deadline", async (context) => {
                    const { value, elapsed } = await inMockTime(context, run);
                    assert.equal(value.ok, false, JSON.stringify(value));
                    assert.ok(
                        elapsed <= LONGEST_STEP_MILLISECONDS,
                        `the read took ${elapsed} ms of mock time`,
                    );
                });
            });
        });
    }

    describe("given a click on a page that answers every command", () => {
        describe("when it runs", () => {
            test("then it should succeed", async (context) => {
                const { value } = await inMockTime(context, () =>
                    clickOn(documentOn({ operations: elementPageOperations() })),
                );
                assert.deepEqual(value, { ok: true, value: undefined });
            });
        });
    });

    describe("given a navigate that loads and then never settles", () => {
        describe("when it runs", () => {
            test("then it should end as a timeout", async (context) => {
                const { value } = await inMockTime(context, () =>
                    fakeDocumentPorts({
                        timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
                        operations: { twoFramesLater: NEVER },
                    }).navigate("/", scriptsEnabled),
                );
                assert.equal(failureCode(value), "timeout");
            });
        });
    });

    describe("given a navigate that loads and settles", () => {
        describe("when it runs", () => {
            test("then it should succeed", async (context) => {
                const { value } = await inMockTime(context, () =>
                    fakeDocumentPorts({ timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS }).navigate(
                        "/",
                        scriptsEnabled,
                    ),
                );
                assert.deepEqual(value, { ok: true, value: undefined });
            });
        });
    });
});
