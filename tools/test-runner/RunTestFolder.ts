// Runs every *.test.ts file under the given folders with Node's built-in test runner, with no
// retries. A folder that does not exist yet, or holds no tests, is reported and skipped, so the
// same scripts work before and after the first tests land.
// Files that drive a real browser run one at a time, after the rest have run in parallel: the
// test project gives each step 2 seconds, and with several browsers and the other tests sharing
// the CPU a browser's own click or page load can take longer. A browser test is one that imports
// the shared browser module, directly or through other test files, by relative path or through the
// #test-support/* import; that one rule decides it.
// Every test's outcome is written to .test-results/tests-<folders>.jsonl for the gates step
// (tools/test-runner/TestResultLine.ts). A file that fails is run once more, only to measure whether
// the run was flaky: the run still fails, whatever the second attempt does.
// CI runs the files apart, each set in its own job, and the gates step reads every job's results:
//   --without-browser           only the files that drive no browser
//   --browser-shard <n>/<count> only the browser files of one shard, still one at a time
//   --require-results           run nothing; fail if a test file has no result in .test-results/,
//                               which is how a shard left out of CI's job list shows up
//   node tools/test-runner/RunTestFolder.ts test/unit test/proofs
//   node tools/test-runner/RunTestFolder.ts --browser-shard 2/3 test/unit test/proofs
// The folders are read from the working folder; this tool's own modules from beside it.
import { spawnSync } from "node:child_process";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { readTestResults, RESULTS_FOLDER, type RerunLine } from "./ReadTestResults.ts";

const BROWSER_MODULE = resolve("test/support/browser/Browsers.ts");
// A relative import, or one through the package's #test-support/* subpath, which names test/support/.
const TEST_IMPORT = /\bfrom\s+['"](\.{1,2}\/[^'"]+|#test-support\/[^'"]+)['"]/g;
const TEST_SUPPORT_PREFIX = "#test-support/";
const REPORTER = pathToFileURL(join(import.meta.dirname, "TestResultLine.ts")).href;
const USAGE =
    "usage: node tools/test-runner/RunTestFolder.ts [--without-browser | --browser-shard <n>/<count> | --require-results] <folder>...";

type BrowserShard = { readonly position: number; readonly count: number };

type RunRequest = {
    readonly folders: readonly string[];
    readonly shouldSkipBrowserFiles: boolean;
    readonly browserShard: BrowserShard | null;
    readonly shouldCheckResults: boolean;
};

// "2/3" as the second of three shards, or undefined when it is not a shard of that many.
function readBrowserShard(text: string | undefined): BrowserShard | undefined {
    const match = /^(\d+)\/(\d+)$/.exec(text ?? "");
    if (match === null) {
        return undefined;
    }
    const position = Number(match[1]);
    const count = Number(match[2]);
    return position >= 1 && position <= count ? { position, count } : undefined;
}

// The request, or undefined when the words don't make one. A mistyped flag must not read as a
// folder: an empty folder passes, so the run would pass having tested nothing.
function readRunRequest(words: readonly string[]): RunRequest | undefined {
    const folders: string[] = [];
    let shouldSkipBrowserFiles = false;
    let browserShard: BrowserShard | null = null;
    let shouldCheckResults = false;
    for (let i = 0; i < words.length; i += 1) {
        const word = words[i] ?? "";
        if (word === "--without-browser") {
            shouldSkipBrowserFiles = true;
        } else if (word === "--require-results") {
            shouldCheckResults = true;
        } else if (word === "--browser-shard") {
            i += 1;
            const shard = readBrowserShard(words[i]);
            if (shard === undefined) {
                return undefined;
            }
            browserShard = shard;
        } else if (word.startsWith("--")) {
            return undefined;
        } else {
            folders.push(word);
        }
    }
    const choices = [shouldSkipBrowserFiles, browserShard !== null, shouldCheckResults].filter(
        Boolean,
    ).length;
    if (choices > 1 || (choices === 1 && folders.length === 0)) {
        return undefined;
    }
    return { folders, shouldSkipBrowserFiles, browserShard, shouldCheckResults };
}

const repositoryPath = (file: string): string => relative(".", file).split(sep).join("/");

// Splits by position in the sorted list, so every job of a run gets the same answer whatever order
// the operating system lists files in.
function splitIntoShards(files: readonly string[], count: number): readonly (readonly string[])[] {
    const sorted = files.toSorted((left, right) =>
        repositoryPath(left).localeCompare(repositoryPath(right), "en"),
    );
    return [...Array(count).keys()].map((shard) =>
        sorted.filter((file, position) => position % count === shard),
    );
}

const filesNotInExactlyOneShard = (
    files: readonly string[],
    shards: readonly (readonly string[])[],
): readonly string[] =>
    files.filter((file) => shards.filter((shard) => shard.includes(file)).length !== 1);

function checkEveryFileHasResults(folders: readonly string[]): number {
    const filesWithResults = new Set(
        [...readTestResults(process.cwd()).tests.values()].map((test) => test.file),
    );
    const missing = folders
        .flatMap(findTestFiles)
        .map(repositoryPath)
        .filter((file) => !filesWithResults.has(file));
    for (const file of missing) {
        console.error(`${file} has no result in ${RESULTS_FOLDER}/`);
    }
    console.log(
        missing.length === 0
            ? "every test file has a result"
            : `${missing.length} test file(s) have no result: did a job or shard not run?`,
    );
    return missing.length === 0 ? 0 : 1;
}

// Whether the file imports the browser module, following its imports of other test files.
function drivesBrowser(file: string, seen = new Set<string>()): boolean {
    const path = resolve(file);
    if (path === BROWSER_MODULE) {
        return true;
    }
    if (seen.has(path) || !existsSync(path)) {
        return false;
    }
    seen.add(path);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(TEST_IMPORT)) {
        const imported = match[1];
        if (imported === undefined) {
            continue;
        }
        const importedPath = imported.startsWith(TEST_SUPPORT_PREFIX)
            ? resolve("test/support", imported.slice(TEST_SUPPORT_PREFIX.length))
            : join(dirname(path), imported);
        if (drivesBrowser(importedPath, seen)) {
            return true;
        }
    }
    return false;
}

type Attempt = { readonly status: number; readonly lines: readonly string[] };

// Runs the files once, printing the usual report and collecting the result lines.
function runTests(
    files: readonly string[],
    concurrency: number | null,
    scratchFolder: string,
): Attempt {
    if (files.length === 0) {
        return { status: 0, lines: [] };
    }
    const destination = mkdtempSync(join(scratchFolder, "attempt-"));
    const resultsPath = join(destination, "results.jsonl");
    const limit = concurrency === null ? [] : [`--test-concurrency=${concurrency}`];
    const reporters = [
        "--test-reporter=spec",
        "--test-reporter-destination=stdout",
        `--test-reporter=${REPORTER}`,
        `--test-reporter-destination=${resultsPath}`,
    ];
    const run = spawnSync(process.execPath, ["--test", ...limit, ...reporters, ...files], {
        stdio: "inherit",
    });
    const text = existsSync(resultsPath) ? readFileSync(resultsPath, "utf8") : "";
    return {
        status: run.status ?? 1,
        lines: text.split("\n").filter((line) => line.trim() !== ""),
    };
}

const fieldOf = (value: unknown, key: string): unknown =>
    typeof value === "object" && value !== null
        ? Object.getOwnPropertyDescriptor(value, key)?.value
        : undefined;

// The files with a test that failed (not skipped), as the reporter wrote them.
function failedFiles(lines: readonly string[]): Set<string> {
    const files = new Set<string>();
    for (const line of lines) {
        const value: unknown = JSON.parse(line);
        const file = fieldOf(value, "file");
        if (
            typeof file === "string" &&
            fieldOf(value, "passed") === false &&
            fieldOf(value, "skipped") === false
        ) {
            files.add(file);
        }
    }
    return files;
}

function findTestFiles(folder: string): string[] {
    if (!existsSync(folder)) {
        return [];
    }
    const files: string[] = [];
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
            files.push(...findTestFiles(path));
        } else if (/\.test\.(ts|mts|js|mjs)$/.test(entry.name)) {
            files.push(path);
        }
    }
    return files.sort();
}

// The results file for this choice of files: running the same choice again replaces it, and the
// other choices' files stay, so the gates step reads them all.
function resultsFileFor({ folders, shouldSkipBrowserFiles, browserShard }: RunRequest): string {
    const key = folders
        .map((folder) =>
            relative(".", folder)
                .split(sep)
                .join("-")
                .replace(/[^\w.-]+/g, "-"),
        )
        .join("+");
    const shardPart =
        browserShard === null
            ? ""
            : `-browser-shard-${browserShard.position}-of-${browserShard.count}`;
    return join(
        RESULTS_FOLDER,
        `tests-${key === "" ? "none" : key}${shouldSkipBrowserFiles ? "-without-browser" : ""}${shardPart}.jsonl`,
    );
}

function main(request: RunRequest): number {
    const { folders, shouldSkipBrowserFiles, browserShard } = request;
    const files: string[] = [];
    for (const folder of folders) {
        const found = findTestFiles(folder);
        if (found.length === 0) {
            console.log(`no tests in ${folder} yet`);
        }
        files.push(...found);
    }
    mkdirSync(RESULTS_FOLDER, { recursive: true });
    const resultsFile = resultsFileFor(request);
    if (files.length === 0) {
        writeFileSync(resultsFile, "");
        return 0;
    }
    // Without this file no test counts as a browser test, and every browser test would quietly run in parallel.
    if (!existsSync(BROWSER_MODULE)) {
        console.error(
            `${relative(".", BROWSER_MODULE)} does not exist, so browser tests can't be told from the rest; if it moved, update BROWSER_MODULE in tools/test-runner/RunTestFolder.ts`,
        );
        return 1;
    }
    const scratchFolder = mkdtempSync(join(tmpdir(), "test-results-"));
    try {
        const allBrowserFiles = files.filter((file) => drivesBrowser(file));
        const otherFiles = files.filter((file) => !allBrowserFiles.includes(file));
        let browserFiles = allBrowserFiles;
        if (browserShard !== null) {
            if (allBrowserFiles.length === 0) {
                console.error(`no browser files in ${folders.join(", ")} to split into shards`);
                return 1;
            }
            const shards = splitIntoShards(allBrowserFiles, browserShard.count);
            const missed = filesNotInExactlyOneShard(allBrowserFiles, shards);
            if (missed.length > 0) {
                console.error(
                    `these browser files are not in exactly one shard:\n  ${missed.join("\n  ")}`,
                );
                return 1;
            }
            browserFiles = [...(shards[browserShard.position - 1] ?? [])];
            console.log(
                `browser shard ${browserShard.position} of ${browserShard.count}: ${browserFiles.length} of ${allBrowserFiles.length} browser files`,
            );
        }
        const other = runTests(browserShard === null ? otherFiles : [], null, scratchFolder);
        const browser = runTests(shouldSkipBrowserFiles ? [] : browserFiles, 1, scratchFolder);
        const lines = [...other.lines, ...browser.lines];

        // The measuring rerun: each failed file once more, on its own. It never changes the status.
        const reruns: RerunLine[] = [];
        for (const file of [...failedFiles(lines)].sort()) {
            console.log(
                `\nrunning ${file} once more to measure flakiness; the run fails whatever this attempt does`,
            );
            const rerun = runTests([file], 1, scratchFolder);
            reruns.push({ kind: "rerun", file, passed: rerun.status === 0 });
        }
        const rerunLines = reruns.map((rerun) => JSON.stringify(rerun));
        writeFileSync(resultsFile, [...lines, ...rerunLines].map((line) => `${line}\n`).join(""));
        if (reruns.some((rerun) => rerun.passed)) {
            console.log("flaky: a failed file passed when run again; the run still fails");
        }
        return other.status !== 0 ? other.status : browser.status;
    } finally {
        rmSync(scratchFolder, { recursive: true, force: true });
    }
}

function start(words: readonly string[]): number {
    const request = readRunRequest(words);
    if (request === undefined) {
        console.error(USAGE);
        return 2;
    }
    return request.shouldCheckResults ? checkEveryFileHasResults(request.folders) : main(request);
}

if (import.meta.main) {
    process.exitCode = start(process.argv.slice(2));
}
