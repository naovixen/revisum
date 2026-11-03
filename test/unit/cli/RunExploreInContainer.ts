// Runs the crawl's entry module as a run container starts it, on this machine: a process of its own,
// with one JSON argument and what it needs in its environment. Asynchronous, because a test may serve
// the site the crawl reads from this same process.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { CONTAINER_CRAWL_MODULE } from "../../../packages/cli/src/explore-crawl.ts";
import { REPOSITORY_ROOT } from "../../support/repository.ts";

const CRAWL_TIMEOUT_MILLISECONDS = 60_000;

export const HTTP_PROXY_VARIABLE = "HTTP_PROXY";
export const CRAWL_BOUNDS = {
    maximumPages: 1,
    maximumDepth: 0,
    pageTimeoutMilliseconds: 5_000,
};

export type CrawlProcess = {
    readonly exitCode: number | null;
    readonly stdout: string;
    readonly stderr: string;
};

// A project that may crawl only this origin, on one Chromium target.
export const crawlProjectFile = (origin: string): Readonly<Record<string, unknown>> => ({
    origins: [origin],
    limits: { stepTimeoutMilliseconds: 5_000, maximumSteps: 20 },
    matrix: [
        {
            id: "crawl-chromium",
            adapter: "cdp",
            engine: "chromium",
            device: "desktop-1280",
            locale: "en-GB",
            timezone: "Europe/London",
            colorScheme: "light",
            reducedMotion: "reduce",
        },
    ],
});

// This machine's environment without a proxy of its own: on Windows, a variable's name has no case.
const environmentWithNoProxy = (): Record<string, string | undefined> =>
    Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toUpperCase() !== HTTP_PROXY_VARIABLE),
    );

export function runExploreInContainer(
    input: unknown,
    environment: Readonly<Record<string, string>> = {},
): Promise<CrawlProcess> {
    return new Promise((resolve, reject) => {
        const crawl = spawn(
            process.execPath,
            [join(REPOSITORY_ROOT, CONTAINER_CRAWL_MODULE), JSON.stringify(input)],
            {
                cwd: REPOSITORY_ROOT,
                ["env"]: { ...environmentWithNoProxy(), ...environment },
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                timeout: CRAWL_TIMEOUT_MILLISECONDS,
            },
        );
        let stdout = "";
        let stderr = "";
        crawl.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        crawl.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        crawl.on("error", reject);
        crawl.on("close", (exitCode) => {
            resolve({ exitCode, stdout, stderr });
        });
    });
}
