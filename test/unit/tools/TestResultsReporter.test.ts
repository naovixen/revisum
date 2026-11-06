// Node names as a test's file the module that called test(), so a shared contract under test/support
// would be credited to itself. The reporter credits each result to the test file whose top-level
// suite runs it, and the gates read those lines to tell which test files passed.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import testResultsReporter from "../../../tools/test-results-reporter.ts";

type ReporterEvent = { readonly type: string; readonly data?: unknown };

const FIRST_TEST_FILE = "test/unit/a.test.ts";
const SECOND_TEST_FILE = "test/unit/b.test.ts";
const SUPPORT_MODULE = "test/support/shared-contract.ts";

// Node's own field names, which the reporter reads as they are.
const NODE_DURATION_FIELD = "duration_ms";

const onDisk = (file: string) => join(process.cwd(), file);

const started = (file: string, name: string, nesting: number): ReporterEvent => ({
    type: "test:start",
    data: { file: onDisk(file), name, nesting, line: 1 },
});

const finished = (
    type: "test:pass" | "test:fail",
    file: string,
    name: string,
    nesting: number,
    extra: { readonly isSuite?: boolean; readonly skip?: boolean } = {},
): ReporterEvent => ({
    type,
    data: {
        file: onDisk(file),
        name,
        nesting,
        line: 7,
        ...(extra.skip === true ? { skip: true } : {}),
        details: {
            [NODE_DURATION_FIELD]: 2.4,
            ...(extra.isSuite === true ? { type: "suite" } : {}),
        },
    },
});

// Two test files, each running the shared contract from its top-level suite, then a file that
// fails to load before any of its suites start.
const EVENTS: readonly ReporterEvent[] = [
    started(FIRST_TEST_FILE, "Using the first store", 0),
    started(SUPPORT_MODULE, "given the shared contract", 1),
    started(SUPPORT_MODULE, "then it should keep a value", 2),
    finished("test:pass", SUPPORT_MODULE, "then it should keep a value", 2),
    started(SUPPORT_MODULE, "then it should forget nothing", 2),
    finished("test:pass", SUPPORT_MODULE, "then it should forget nothing", 2, { skip: true }),
    finished("test:pass", SUPPORT_MODULE, "given the shared contract", 1, { isSuite: true }),
    finished("test:pass", FIRST_TEST_FILE, "Using the first store", 0, { isSuite: true }),
    started(SECOND_TEST_FILE, "Using the second store", 0),
    started(SUPPORT_MODULE, "given the shared contract", 1),
    started(SUPPORT_MODULE, "then it should keep a value", 2),
    finished("test:fail", SUPPORT_MODULE, "then it should keep a value", 2),
    finished("test:fail", SUPPORT_MODULE, "given the shared contract", 1, { isSuite: true }),
    finished("test:fail", SECOND_TEST_FILE, "Using the second store", 0, { isSuite: true }),
    finished("test:fail", "test/unit/broken.test.ts", "test/unit/broken.test.ts", 0),
];

// The runner hands its events over one at a time, as an async iterable.
const eventsOf = (events: readonly ReporterEvent[]): AsyncIterable<ReporterEvent> => ({
    [Symbol.asyncIterator]() {
        const remaining = events.values();
        return {
            next: () => Promise.resolve(remaining.next()),
        };
    },
});

const reportedLines = async (events: readonly ReporterEvent[]): Promise<readonly unknown[]> => {
    const lines: unknown[] = [];
    for await (const text of testResultsReporter(eventsOf(events))) {
        const line: unknown = JSON.parse(text);
        lines.push(line);
    }
    return lines;
};

describe("Using the test results reporter", () => {
    describe("given two test files that each run a shared contract from their top-level suite", () => {
        describe("and a file that fails to load", () => {
            describe("when the runner's events are reported", () => {
                test("then it should credit the contract's tests to the first file, under its suite", async () => {
                    const lines = await reportedLines(EVENTS);
                    assert.deepEqual(lines.slice(0, 2), [
                        {
                            kind: "test",
                            file: FIRST_TEST_FILE,
                            name: "Using the first store > given the shared contract > then it should keep a value",
                            line: 7,
                            passed: true,
                            skipped: false,
                            durationMilliseconds: 2,
                        },
                        {
                            kind: "test",
                            file: FIRST_TEST_FILE,
                            name: "Using the first store > given the shared contract > then it should forget nothing",
                            line: 7,
                            passed: false,
                            skipped: true,
                            durationMilliseconds: 2,
                        },
                    ]);
                });

                test("then it should credit the second file's results to it, not the first", async () => {
                    const lines = await reportedLines(EVENTS);
                    assert.deepEqual(lines[2], {
                        kind: "test",
                        file: SECOND_TEST_FILE,
                        name: "Using the second store > given the shared contract > then it should keep a value",
                        line: 7,
                        passed: false,
                        skipped: false,
                        durationMilliseconds: 2,
                    });
                });

                test("then it should keep the unloadable file's own name on its failed result", async () => {
                    const lines = await reportedLines(EVENTS);
                    assert.deepEqual(lines[3], {
                        kind: "test",
                        file: "test/unit/broken.test.ts",
                        name: "test/unit/broken.test.ts",
                        line: 7,
                        passed: false,
                        skipped: false,
                        durationMilliseconds: 2,
                    });
                });

                test("then it should write no suites and never name the shared contract's module as a file", async () => {
                    const lines = await reportedLines(EVENTS);
                    assert.equal(lines.length, 4);
                    const files = lines.map(
                        (line): unknown => Object.getOwnPropertyDescriptor(line, "file")?.value,
                    );
                    assert.ok(!files.includes(SUPPORT_MODULE), `credited to ${SUPPORT_MODULE}`);
                });
            });
        });
    });
});
