// Runs inside the run container, started through RunnerHandle.exec, as well as being what a test
// outside imports to start it. It serves one WebRTC page on the container's own loopback and opens it
// in one of two browsers, then says what state that left. The page never hears whether its datagrams
// or connections landed: only a witness at the address it aimed for can tell.
import assert from "node:assert/strict";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { setTimeout as pause } from "node:timers/promises";
import type { RunnerHandle } from "@revisum/contracts";
import {
    CREATE_TARGET,
    cdpDriver,
    egressThroughExistingProxy,
    launchChromium,
} from "@revisum/driver-cdp";
import { createRunService, parseProject, planParser } from "@revisum/engine";
import { navigate, rawPlan, testId, textEquals } from "../support/browser/RawPlan.ts";
import { BROWSERS } from "../support/browsers.ts";
import { startFixtureServer, type FixtureServer } from "../support/fixture-server.ts";
import { systemClock } from "../support/memory-ports.ts";
import { baseUrlOf, clearRun, trustedProjectFrom } from "../support/policy-clearance.ts";
import { FIXTURES } from "../support/repository.ts";
import {
    ATTEMPT_SETTLED,
    ATTEMPT_STATE,
    WEBRTC_CHANNELS,
    attemptPage,
    type ChannelAddress,
} from "../proofs/EgressChannels.ts";
import { realRunPorts } from "../support/RealRunPorts.ts";

const THIS_FILE_IN_THE_WORKSPACE = "test/containers/AttemptWebRtcInside.ts";
const PAGE_PATH = "/attempt.html";
const TARGET_ID = "cdp-chromium";
const SEED = 7;
const FIXED_TIME_MILLISECONDS = Date.UTC(2026, 9, 29, 12, 0, 0);
const BARE_BROWSER_WAIT_MILLISECONDS = 4_000;

export const WebRtcBrowser = {
    // A whole plan run through the driver and the run's egress proxy, as a real run opens a page.
    Run: "run",
    // A browser with no driver and no proxy, whose WebRTC nothing has turned off, so only the
    // container's network stands between the page and the address.
    Bare: "bare",
} as const;

export type WebRtcBrowser = (typeof WebRtcBrowser)[keyof typeof WebRtcBrowser];

export type WebRtcAttempt = {
    readonly channelName: string;
    readonly address: Pick<ChannelAddress, "hostname" | "port" | "datagramPort">;
    readonly browser: WebRtcBrowser;
};

const BARE_BROWSER_FLAGS: readonly string[] = [
    "--headless",
    "--no-first-run",
    "--disable-background-networking",
    // Chromium on Linux would otherwise take the run's HTTP_PROXY variable as its proxy.
    "--no-proxy-server",
];

const OPENED_IN_BARE_BROWSER = "Opened";

function pageFor({ channelName, address }: WebRtcAttempt): string {
    const channel = WEBRTC_CHANNELS.find((candidate) => candidate.name === channelName);
    assert.ok(channel !== undefined, `no WebRTC channel named ${channelName}`);
    return attemptPage(
        channel.page({
            address: { ...address, origin: `http://${address.hostname}:${address.port}` },
            frameHostOrigin: "",
            workerScriptPath: "",
        }),
    );
}

async function openInBareBrowser(fixture: FixtureServer): Promise<string> {
    const launched = await launchChromium(BROWSERS.chrome, {
        arguments: BARE_BROWSER_FLAGS,
        profilePrefix: "webrtc-attempt-",
    });
    try {
        await launched.connection.ask(undefined, CREATE_TARGET, {
            url: `${fixture.origin}${PAGE_PATH}`,
        });
        await pause(BARE_BROWSER_WAIT_MILLISECONDS);
    } finally {
        await launched.stop();
    }
    return OPENED_IN_BARE_BROWSER;
}

async function openInRun(fixture: FixtureServer): Promise<string> {
    const proxyServer = process.env["HTTP_PROXY"];
    assert.ok(proxyServer !== undefined && proxyServer !== "", "the run container has a proxy");
    const projectFile = {
        origins: [fixture.origin],
        limits: { stepTimeoutMilliseconds: 10_000 },
        matrix: [
            {
                id: TARGET_ID,
                adapter: "cdp",
                engine: "chromium",
                device: "desktop-1280",
                locale: "en-GB",
                timezone: "Europe/London",
                colorScheme: "light",
                reducedMotion: "reduce",
            },
        ],
    };
    const project = parseProject(projectFile);
    assert.ok(project.ok, "the project parses");
    const parsedPlan = planParser(project.value)(
        rawPlan(
            {
                featureId: "ISOLATION-1",
                specReference: "specs/isolation.md#webrtc",
                title: "A page tries WebRTC",
            },
            TARGET_ID,
            [
                navigate(PAGE_PATH),
                textEquals(testId(ATTEMPT_STATE), ATTEMPT_SETTLED, "isolation.attempt-settled"),
            ],
        ),
    );
    assert.ok(parsedPlan.ok, "the plan parses");
    const target = project.value.matrix[0];
    assert.ok(target !== undefined, "the project has a target");
    const ports = realRunPorts({
        // The page is on the container's own loopback, which the proxy, in another container,
        // cannot reach; everything else goes through the proxy.
        drivers: new Map([
            [
                "cdp",
                cdpDriver({
                    executablePath: BROWSERS.chrome,
                    egress: egressThroughExistingProxy(proxyServer),
                }),
            ],
        ]),
        clock: systemClock,
    });
    const result = await createRunService(ports).run(
        clearRun(parsedPlan.value, await trustedProjectFrom(projectFile), target.id),
        {
            baseUrl: baseUrlOf(fixture.origin),
            seed: SEED,
            fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
            fixtures: fixture.fixtures,
            host: { platform: platform(), arch: arch() },
        },
    );
    return result.state;
}

async function attemptInThisContainer(attempt: WebRtcAttempt): Promise<void> {
    const body = pageFor(attempt);
    const fixture = await startFixtureServer(
        join(FIXTURES, "egress-app"),
        undefined,
        new Map([
            [PAGE_PATH, () => ({ headers: { "content-type": "text/html; charset=utf-8" }, body })],
        ]),
    );
    try {
        const state =
            attempt.browser === WebRtcBrowser.Run
                ? await openInRun(fixture)
                : await openInBareBrowser(fixture);
        console.log(JSON.stringify({ state }));
    } finally {
        await fixture.close();
    }
}

// Starts the attempt inside the run container and answers with the state it printed.
export async function attemptWebRtcInside(
    handle: RunnerHandle,
    attempt: WebRtcAttempt,
): Promise<string> {
    const ran = await handle.exec([
        "node",
        THIS_FILE_IN_THE_WORKSPACE,
        JSON.stringify(attempt),
    ]);
    assert.ok(ran.ok, `the attempt inside the container did not run: ${ran.ok ? "" : ran.error.detail}`);
    const outcome = ran.value;
    assert.equal(outcome.exitCode, 0, `the attempt inside the container failed: ${outcome.stderr}`);
    const printed = JSON.parse(outcome.stdout.trim().split("\n").at(-1) ?? "null") as {
        readonly state: string;
    };
    return printed.state;
}

export const BARE_BROWSER_STATE = OPENED_IN_BARE_BROWSER;

if (import.meta.main) {
    await attemptInThisContainer(JSON.parse(process.argv[2] ?? "null") as WebRtcAttempt);
}
