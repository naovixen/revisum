// What a browser the driver launched asks of a session's proxy on its own, with no page asking. Chrome
// has traffic of its own, which belongs at a browser-wide proxy that leads nowhere, and creating a
// browser context can send a request through that context's proxy. Either would make refusals vary
// with what the browser felt like doing, and on a host run reach real services. The session's proxy
// here answers everything itself, and carries only the test's own page server, so nothing can leave
// the machine.
import assert from "node:assert/strict";
import { join } from "node:path";
import { connect } from "node:net";
import { after, before, describe, test } from "node:test";
import type { OwnBrowserDriver } from "@revisum/driver-cdp";
import { defaultRedactor, success, type SessionEnvironment } from "@revisum/engine";
import { startBrowserHarness, type BrowserHarness } from "#test-support/browser/BrowserHarness.ts";
import {
    ADAPTER_OF_TARGET,
    BrowserTarget,
    englishMatrix,
} from "#test-support/browser/BrowserTarget.ts";
import { navigate, testId, textEquals } from "#test-support/browser/RawPlan.ts";
import type { EgressSourceForTest } from "#test-support/browser/driver/SessionEgressForTest.ts";
import {
    FIXED_TIME_MILLISECONDS,
    SEED,
    capabilityPlan,
} from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { FIXTURES } from "#test-support/repository/RepositoryRoot.ts";
import { onTarget } from "#test-support/TestTier.ts";
import { ATTEMPT_SETTLED, ATTEMPT_STATE, attemptPage } from "./support/EgressChannels.ts";
import { EXECUTABLE_OF_TARGET, driverWithEgress } from "./support/HostBrowserDrivers.ts";
import { startRecordingProxy, type RecordingProxy } from "./support/StartRecordingProxy.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { baseUrlOf } from "#test-support/builders/ClearRun.ts";

const BACKGROUND_HOSTS = [
    "accounts.google.com",
    "update.googleapis.com",
    "clients2.google.com",
    "www.google.com",
];

// Reserved for examples, and answered by the recording proxy. It has to be declared, or the driver's
// allow-list would refuse the request before the proxy saw it.
const DECLARED_HOST = "declared-address.example";
const DECLARED_ORIGIN = `https://${DECLARED_HOST}`;
const PAGE_HOST = "127.0.0.1";

const QUIET_PATH = "/quiet.html";
const FETCHING_PATH = "/fetching.html";

const WEBRTC_POLICY = "disable_non_proxied_udp";
const AI_MODE_FEATURE = "AimEnabled";
const PORT_RANDOMISATION_FEATURE = "TcpPortRandomizationWin";
const DISABLE_FEATURES = "--disable-features=";
const BROWSER_WIDE_PROXY = "--proxy-server=";
const DEAD_PROXY_WAIT_MILLISECONDS = 2_000;

const htmlRoute =
    (attempt: string): FixtureRoute =>
    () => ({
        headers: { "content-type": "text/html; charset=utf-8" },
        body: attemptPage(attempt),
    });

const stepsOnPage = (path: string): readonly unknown[] => [
    navigate(path),
    textEquals(testId(ATTEMPT_STATE), ATTEMPT_SETTLED, "background.attempt-settled"),
];

let proxy: RecordingProxy;
let harness: BrowserHarness;

const egressOnRecordingProxy: EgressSourceForTest = () =>
    Promise.resolve(
        success({
            proxy: { server: proxy.server, includeLoopback: true },
            refusedOrigins: () => success([]),
            connectionFailures: () => [],
            close: () => Promise.resolve(success(undefined)),
        }),
    );

const recordingDriverFor = (target: BrowserTarget): OwnBrowserDriver =>
    driverWithEgress({
        executablePath: EXECUTABLE_OF_TARGET[target],
        egress: egressOnRecordingProxy,
    });

before(async () => {
    proxy = await startRecordingProxy({ relayedHost: PAGE_HOST });
    harness = await startBrowserHarness({
        fixtureFolder: join(FIXTURES, "sites", "capability-app"),
        routes: new Map<string, FixtureRoute>([
            [QUIET_PATH, htmlRoute("")],
            [
                FETCHING_PATH,
                htmlRoute(
                    `<script>fetch(${JSON.stringify(`${DECLARED_ORIGIN}/`)}, { mode: "no-cors" });</script>`,
                ),
            ],
        ]),
        projectFile: (origin) => ({
            origins: [origin, DECLARED_ORIGIN],
            limits: { stepTimeoutMilliseconds: 10_000, maximumSteps: 20 },
            matrix: englishMatrix(Object.values(BrowserTarget)),
        }),
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        drivers: new Map(
            Object.values(BrowserTarget).map((target) => [
                ADAPTER_OF_TARGET[target],
                recordingDriverFor(target),
            ]),
        ),
        planFor: capabilityPlan,
    });
});
after(async () => {
    await harness.close();
    await proxy.close();
});

async function runPage(targetId: BrowserTarget, path: string): Promise<void> {
    proxy.forgetAskedHosts();
    const ran = await harness.runSteps(targetId, stepsOnPage(path));
    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result));
}

const sessionEnvironment = (): SessionEnvironment => ({
    baseUrl: baseUrlOf(harness.origin),
    allowedOrigins: harness.project.origins,
    seed: SEED,
    fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
    sensitiveSelectors: defaultRedactor().selectors,
    timeoutMilliseconds: 5_000,
});

const readCommandLineText = (): string =>
    document.getElementById("command_line")?.textContent ?? "";

// The running browser's own command line, as chrome://version shows it.
async function launchFlags(target: BrowserTarget): Promise<readonly string[]> {
    const opened = await recordingDriverFor(target).open(
        harness.target(target),
        sessionEnvironment(),
    );
    assert.ok(opened.ok, JSON.stringify(opened));
    try {
        const navigated = await opened.value.navigate("chrome://version", scriptsEnabled);
        assert.ok(navigated.ok, JSON.stringify(navigated));
        const text = await opened.value.evaluate(readCommandLineText);
        return text
            .split(/\s+/)
            .map((flag) => flag.replace(/^"|"$/g, ""))
            .filter((flag) => flag !== "");
    } finally {
        await opened.value.close();
    }
}

// Chromium reads only the last --disable-features flag.
function disabledFeatures(flags: readonly string[]): readonly string[] {
    const last = flags.filter((flag) => flag.startsWith(DISABLE_FEATURES)).at(-1);
    return last === undefined ? [] : last.slice(DISABLE_FEATURES.length).split(",");
}

// Whether a proxy opens a tunnel when asked: refusing the connection, closing it or answering with
// anything else all leave Chrome's own traffic with nowhere to go.
function opensATunnel(proxyServer: string): Promise<boolean> {
    const { hostname, port } = new URL(proxyServer);
    return new Promise((resolve) => {
        const socket = connect(Number(port), hostname);
        socket.setTimeout(DEAD_PROXY_WAIT_MILLISECONDS, () => socket.destroy());
        let answer = "";
        socket.on("data", (chunk: Buffer) => {
            answer += chunk.toString("latin1");
            socket.destroy();
        });
        socket.on("error", () => undefined);
        socket.on("close", () => {
            resolve(/^HTTP\/1\.[01] 2\d\d/.test(answer));
        });
        socket.write(
            `CONNECT ${BACKGROUND_HOSTS[0] ?? ""}:443 HTTP/1.1\r\nHost: ${BACKGROUND_HOSTS[0] ?? ""}:443\r\n\r\n`,
        );
    });
}

describe("Using a browser the driver launched", () => {
    for (const targetId of Object.values(BrowserTarget)) {
        describe(`given a run on ${targetId}`, onTarget(targetId), () => {
            describe("and a page that asks for nothing outside its own origin", () => {
                describe("when the run opens it and waits for it to settle", () => {
                    let asked: readonly string[];
                    let relayed: readonly string[];
                    before(async () => {
                        await runPage(targetId, QUIET_PATH);
                        asked = proxy.askedHosts();
                        relayed = proxy.relayedRequests();
                    });

                    for (const host of BACKGROUND_HOSTS) {
                        test(`then it should attempt no connection to ${host} through the session's proxy`, () => {
                            assert.ok(!asked.includes(host), `asked: ${JSON.stringify(asked)}`);
                        });
                    }

                    test("then it should attempt no connection to any other address through the session's proxy", () => {
                        const others = asked.filter((host) => !BACKGROUND_HOSTS.includes(host));
                        assert.deepEqual(others, []);
                    });

                    test("then it should fetch the page itself through the session's proxy, so its silence means something", () => {
                        assert.ok(
                            relayed.some((url) => url.endsWith(QUIET_PATH)),
                            `carried: ${JSON.stringify(relayed)}`,
                        );
                    });
                });
            });

            describe("and a page that fetches a declared address on another site", () => {
                describe("when the run opens it", () => {
                    test("then it should go on to a TLS handshake there through the session's proxy, so the proxy's silence means something", async () => {
                        await runPage(targetId, FETCHING_PATH);
                        assert.ok(
                            proxy.tunnelledHosts().includes(DECLARED_HOST),
                            `tunnelled: ${JSON.stringify(proxy.tunnelledHosts())}`,
                        );
                    });
                });
            });
        });
    }

    describe("given Chrome, whose own traffic must have nowhere to go", () => {
        describe("when a session reads the browser's launch flags", () => {
            let flags: readonly string[];
            before(async () => {
                flags = await launchFlags(BrowserTarget.Chrome);
            });

            test("then it should send both WebRTC policy flags, since each browser build honours only one", () => {
                assert.ok(
                    flags.includes(`--webrtc-ip-handling-policy=${WEBRTC_POLICY}`),
                    flags.join(" "),
                );
                assert.ok(
                    flags.includes(`--force-webrtc-ip-handling-policy=${WEBRTC_POLICY}`),
                    flags.join(" "),
                );
            });

            test("then it should turn off the feature whose request goes through a new context's proxy", () => {
                assert.ok(disabledFeatures(flags).includes(AI_MODE_FEATURE), flags.join(" "));
            });

            test("then it should keep port randomisation off in the same list", () => {
                assert.ok(
                    disabledFeatures(flags).includes(PORT_RANDOMISATION_FEATURE),
                    flags.join(" "),
                );
            });

            test("then it should name a browser-wide proxy on this machine that opens no tunnel", async () => {
                const flag = flags.find((candidate) => candidate.startsWith(BROWSER_WIDE_PROXY));
                assert.ok(flag !== undefined, flags.join(" "));
                const proxyServer = flag.slice(BROWSER_WIDE_PROXY.length);
                assert.equal(new URL(proxyServer).hostname, PAGE_HOST);
                assert.equal(await opensATunnel(proxyServer), false);
            });
        });
    });

    describe("given a proxy that does open tunnels", () => {
        describe("when the same check asks it for one", () => {
            test("then it should say so, so the browser-wide proxy's silence means something", async () => {
                assert.equal(await opensATunnel(proxy.server), true);
            });
        });
    });
});
