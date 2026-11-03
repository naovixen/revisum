// Where no egress proxy runs, the driver's own allow-list is all that stands between a page and an
// undeclared address. Each channel here is tried through a whole run in a real headless browser,
// against real servers on loopback: the page's own origin, a declared origin on another site, and
// an undeclared one on a third. Only the undeclared server's own record can show that nothing got
// through. The same page aimed at the declared origin is the counter-example, which shows the
// channel works in this fixture, so an empty record means something.
//
// Preconnect and dns-prefetch have no such counter-example, because Chromium makes neither in the
// browser context a session runs in, whatever the address. Their counter-example is the same page
// in a browser's default context, where the same witness does see them.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import {
    CdpConnection,
    cdpDriver,
    launchChromium,
    launchSharedBrowser,
    type LaunchedChromium,
    type SharedBrowser,
} from "@revisum/driver-cdp";
import {
    startBrowserHarness,
    type BrowserHarness,
    type BrowserRun,
} from "#test-support/browser/BrowserHarness.ts";
import {
    ADAPTER_OF_TARGET,
    BrowserTarget,
    englishMatrix,
} from "#test-support/browser/BrowserTarget.ts";
import { driversForTargets } from "#test-support/browser/CreateBrowserDriver.ts";
import { navigate, testId, textEquals } from "#test-support/browser/RawPlan.ts";
import { BROWSERS } from "#test-support/browsers.ts";
import { FIXED_TIME_MILLISECONDS, SEED, capabilityPlan } from "#test-support/capability-harness.ts";
import type { FixtureRoute } from "#test-support/fixture-server.ts";
import { FIXTURES } from "#test-support/repository.ts";
import { onTarget } from "#test-support/TestTier.ts";
import {
    ATTEMPT_SETTLED,
    ATTEMPT_STATE,
    EGRESS_CHANNELS,
    attemptPage,
    dnsPrefetchOf,
    preconnectTo,
    type ChannelAddress,
    type EgressChannel,
} from "./EgressChannels.ts";
import {
    Arrival,
    framePath,
    startRecordingOrigin,
    type RecordingOrigin,
} from "./StartRecordingOrigin.ts";

const STEP_TIMEOUT_MILLISECONDS = 10_000;
const LOCALE = "en-GB";
const OUT_OF_PROCESS_FRAME_CHANNEL = "out-of-process-frame";
const DEFAULT_CONTEXT_WAIT_MILLISECONDS = 2_000;

// A name under .localhost resolves inside Chromium, so looking one up asks no outside resolver.
const UNDECLARED_NAME = "undeclared-name.localhost";

// The network flags of a browser these tests launch themselves. The driver offers no way to add the
// network log's flag, so a test that needs that log cannot use the driver's own launch. Any name
// outside loopback fails here, so these browsers' own background traffic never leaves the machine.
const networkLogFlags = (logFile: string): readonly string[] => [
    "--headless",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-features=TcpPortRandomizationWin",
    "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.* , EXCLUDE *.localhost",
    `--lang=${LOCALE}`,
    `--log-net-log=${logFile}`,
];

const AddressKind = { Undeclared: "undeclared", Declared: "declared" } as const;
type AddressKind = (typeof AddressKind)[keyof typeof AddressKind];

const PRECONNECT_PATH = "/preconnect.html";
const DNS_PREFETCH_PATH = "/dns-prefetch.html";

const pagePath = (channelName: string, kind: AddressKind): string => `/${channelName}/${kind}.html`;
const workerScriptPath = (channelName: string, kind: AddressKind): string =>
    `/${channelName}/${kind}.js`;

const htmlRoute =
    (body: string): FixtureRoute =>
    () => ({ headers: { "content-type": "text/html; charset=utf-8" }, body });

const scriptRoute =
    (body: string): FixtureRoute =>
    () => ({ headers: { "content-type": "text/javascript" }, body });

let undeclared: RecordingOrigin;
let declared: RecordingOrigin;
let harness: BrowserHarness;
const scratchFolder = mkdtempSync(join(tmpdir(), "egress-without-proxy-"));

function channelRoutes(
    channel: EgressChannel,
    kind: AddressKind,
    address: ChannelAddress,
): readonly (readonly [string, FixtureRoute])[] {
    const scriptPath = workerScriptPath(channel.name, kind);
    const page = attemptPage(
        channel.page({ address, frameHostOrigin: declared.origin, workerScriptPath: scriptPath }),
    );
    return [
        [pagePath(channel.name, kind), htmlRoute(page)],
        ...(channel.workerScript === undefined
            ? []
            : ([[scriptPath, scriptRoute(channel.workerScript(address))]] as const)),
    ];
}

before(async () => {
    // Different loopback addresses are different sites, so a frame of one in a page of another runs
    // out of process, as a real third party's would.
    undeclared = await startRecordingOrigin("127.0.0.2");
    declared = await startRecordingOrigin("127.0.0.3");
    const routes = new Map<string, FixtureRoute>([
        ...EGRESS_CHANNELS.flatMap((channel) => [
            ...channelRoutes(channel, AddressKind.Undeclared, undeclared),
            ...channelRoutes(channel, AddressKind.Declared, declared),
        ]),
        [PRECONNECT_PATH, htmlRoute(attemptPage(preconnectTo(undeclared)))],
        [DNS_PREFETCH_PATH, htmlRoute(attemptPage(dnsPrefetchOf(UNDECLARED_NAME)))],
    ]);
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "capability-app"),
        routes,
        projectFile: (origin) => ({
            origins: [origin, declared.origin],
            limits: { stepTimeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS, maximumSteps: 20 },
            matrix: englishMatrix(Object.values(BrowserTarget)),
        }),
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        drivers: driversForTargets(Object.values(BrowserTarget)),
        planFor: capabilityPlan,
    });
});
after(async () => {
    await harness.close();
    await declared.close();
    await undeclared.close();
    rmSync(scratchFolder, { recursive: true, force: true });
});

const stepsOnPage = (path: string): readonly unknown[] => [
    navigate(path),
    textEquals(testId(ATTEMPT_STATE), ATTEMPT_SETTLED, "egress.attempt-settled"),
];

function assertPassed(ran: BrowserRun): void {
    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result));
}

async function runPage(targetId: BrowserTarget, path: string): Promise<BrowserRun> {
    undeclared.forgetArrivals();
    declared.forgetArrivals();
    const ran = await harness.runSteps(targetId, stepsOnPage(path));
    assertPassed(ran);
    return ran;
}

const sharedBrowserFrom = (launched: LaunchedChromium, executablePath: string): SharedBrowser => ({
    executablePath,
    locale: LOCALE,
    proxy: undefined,
    webSocketUrl: launched.webSocketUrl,
    processId: launched.browserProcess.pid ?? -1,
    isAlive: () => launched.browserProcess.exitCode === null,
});

const networkLogFile = (name: string): string => join(scratchFolder, `${name}.json`);

// Chromium's own network log is the only local witness of a name lookup.
async function runWithNetworkLog(
    path: string,
): Promise<{ readonly ran: BrowserRun; readonly networkLog: string }> {
    const logFile = networkLogFile("through-driver");
    const executablePath = BROWSERS.chrome;
    const launched = await launchChromium(executablePath, {
        arguments: networkLogFlags(logFile),
        profilePrefix: "egress-network-log-",
    });
    let ran: BrowserRun;
    try {
        const shared = sharedBrowserFrom(launched, executablePath);
        const driver = cdpDriver({ executablePath, browserSource: () => Promise.resolve(shared) });
        ran = await harness.runSteps(BrowserTarget.Chrome, stepsOnPage(path), {
            drivers: new Map([[ADAPTER_OF_TARGET[BrowserTarget.Chrome], driver]]),
        });
    } finally {
        await launched.stop();
    }
    assertPassed(ran);
    return { ran, networkLog: readFileSync(logFile, "utf8") };
}

// The page opened in a browser's default context, with no driver or allow-list, and left to run.
// Returns the browser's network log.
async function loadInDefaultContext(path: string): Promise<string> {
    undeclared.forgetArrivals();
    const logFile = networkLogFile("default-context");
    const launched = await launchChromium(BROWSERS.chrome, {
        arguments: networkLogFlags(logFile),
        profilePrefix: "egress-default-context-",
    });
    try {
        await launched.connection.send(undefined, "Target.createTarget", {
            url: harness.url(path),
        });
        await pause(DEFAULT_CONTEXT_WAIT_MILLISECONDS);
    } finally {
        await launched.stop();
    }
    return readFileSync(logFile, "utf8");
}

// The urls of the iframe targets alive in the driver's browser while a run holds the page open. A
// frame the browser runs in the page's own process has no target.
async function outOfProcessFramesDuringRun(path: string): Promise<readonly string[]> {
    const executablePath = BROWSERS.chrome;
    const browser = await launchSharedBrowser({ executablePath, locale: LOCALE, proxy: undefined });
    const control = await CdpConnection.open(browser.webSocketUrl);
    let frameUrls: readonly string[] = [];
    try {
        const driver = cdpDriver({ executablePath, browserSource: () => Promise.resolve(browser) });
        await harness.runSteps(BrowserTarget.Chrome, stepsOnPage(path), {
            drivers: new Map([[ADAPTER_OF_TARGET[BrowserTarget.Chrome], driver]]),
            read: [],
            beforePageRead: async () => {
                const { targetInfos } = await control.send<{
                    targetInfos: readonly { readonly url: string }[];
                }>(undefined, "Target.getTargets", { filter: [{ type: "iframe" }] });
                frameUrls = targetInfos.map((info) => info.url);
            },
        });
    } finally {
        control.close();
        await browser.stop();
    }
    return frameUrls;
}

const isConnection = (arrival: string): boolean => arrival === Arrival.Connection;

const showsBlocked = (ran: BrowserRun, hostname: string): boolean =>
    ran.result.blockedOrigins.some((origin) => origin.includes(hostname));

describe("Using the browser allow-list of a run with no egress proxy", () => {
    for (const targetId of Object.values(BrowserTarget)) {
        describe(`given a run on ${targetId}`, onTarget(targetId), () => {
            for (const channel of EGRESS_CHANNELS) {
                describe(`and a page that ${channel.attempt}`, () => {
                    describe("when the address it uses is undeclared", () => {
                        let ran: BrowserRun;
                        let arrivals: readonly string[];
                        before(async () => {
                            const path = pagePath(channel.name, AddressKind.Undeclared);
                            ran = await runPage(targetId, path);
                            arrivals = undeclared.arrivals();
                        });

                        test("then it should send that address nothing", () => {
                            const sent = arrivals.filter((arrival) => !isConnection(arrival));
                            assert.deepEqual(sent, []);
                        });

                        test("then it should open no connection to that address", () => {
                            assert.deepEqual(arrivals.filter(isConnection), []);
                        });

                        test("then it should show the attempt in the run's blocked origins", () => {
                            assert.ok(
                                showsBlocked(ran, undeclared.hostname),
                                `blocked origins: ${JSON.stringify(ran.result.blockedOrigins)}`,
                            );
                        });
                    });

                    describe("when the address it uses is declared", () => {
                        let ran: BrowserRun;
                        let arrivals: readonly string[];
                        before(async () => {
                            const path = pagePath(channel.name, AddressKind.Declared);
                            ran = await runPage(targetId, path);
                            arrivals = declared.arrivals();
                        });

                        test("then it should arrive at that address", () => {
                            assert.ok(
                                arrivals.includes(channel.arrival),
                                `arrived: ${JSON.stringify(arrivals)}`,
                            );
                        });

                        test("then it should block nothing", () => {
                            assert.deepEqual(ran.result.blockedOrigins, []);
                        });
                    });
                });
            }

            describe("and a page that asks to preconnect to an undeclared address", () => {
                describe("when the run opens it", () => {
                    test("then it should open no connection to that address", async () => {
                        await runPage(targetId, PRECONNECT_PATH);
                        assert.deepEqual(undeclared.arrivals(), []);
                    });
                });
            });
        });
    }

    describe("given a run on Chrome, which runs a frame of another site out of process", () => {
        describe("when a declared site's frame is on the page", () => {
            test("then it should have a target of its own, so the page's request hold does not cover it", async () => {
                const frames = await outOfProcessFramesDuringRun(
                    pagePath(OUT_OF_PROCESS_FRAME_CHANNEL, AddressKind.Declared),
                );
                assert.ok(
                    frames.some((url) => url.startsWith(`${declared.origin}${framePath()}`)),
                    `frame targets: ${JSON.stringify(frames)}`,
                );
            });
        });
    });

    describe("given a page that asks to dns-prefetch an undeclared name", () => {
        describe("when a run opens it", () => {
            test("then it should never look that name up", async () => {
                const { networkLog } = await runWithNetworkLog(DNS_PREFETCH_PATH);
                assert.ok(!networkLog.includes(UNDECLARED_NAME), "the network log holds the name");
            });
        });

        describe("when a browser's default context opens it, with no driver", () => {
            test("then it should look that name up, so the run's empty log means something", async () => {
                const networkLog = await loadInDefaultContext(DNS_PREFETCH_PATH);
                assert.ok(networkLog.includes(UNDECLARED_NAME), "the network log lacks the name");
            });
        });
    });

    describe("given a page that asks to preconnect to an address", () => {
        describe("when a browser's default context opens it, with no driver", () => {
            test("then it should connect, so the run's silent address means something", async () => {
                await loadInDefaultContext(PRECONNECT_PATH);
                assert.ok(
                    undeclared.arrivals().includes(Arrival.Connection),
                    `arrived: ${JSON.stringify(undeclared.arrivals())}`,
                );
            });
        });
    });
});
