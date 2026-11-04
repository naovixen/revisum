// An audited page is someone else's code, and the audit browser has no proxy to hold WebRTC's UDP back.
// The same page and the same witness show both sides: a browser launched with no WebRTC policy sends the
// witness a datagram, and the audit browser, once it scans that page, sends none.
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as pause } from "node:timers/promises";
import { launchBrowser, scan, type Browser, type PageDriver } from "@revisum/auditor-act";
import { CREATE_TARGET, launchChromium } from "@revisum/driver-cdp";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { startFixtureServer, type FixtureServer } from "#test-support/fixture-server.ts";
import { FIXTURES } from "#test-support/repository.ts";
import { onTarget } from "#test-support/TestTier.ts";
import {
    ATTEMPT_SETTLED,
    ATTEMPT_STATE,
    SETTLE_MILLISECONDS,
    WEBRTC_STUN,
    attemptPage,
} from "./EgressChannels.ts";
import { EXECUTABLE_OF_TARGET } from "./HostBrowserDrivers.ts";
import { Arrival, startRecordingOrigin, type RecordingOrigin } from "./StartRecordingOrigin.ts";

const WEBRTC_POLICY = "disable_non_proxied_udp";
const PAGE_HOST = "127.0.0.1";
const STUN_PATH = "/stun.html";
const WAIT_AFTER_THE_PAGE_MILLISECONDS = SETTLE_MILLISECONDS + 500;

// What the audit browser needs of a launch, without the WebRTC policy, so the comparison is that policy.
const FLAGS_WITH_NO_WEBRTC_POLICY: readonly string[] = [
    "--headless=new",
    "--no-first-run",
    "--disable-background-networking",
    "--disable-features=TcpPortRandomizationWin",
    `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${PAGE_HOST}`,
];

let witness: RecordingOrigin;
let server: FixtureServer;

before(async () => {
    witness = await startRecordingOrigin(PAGE_HOST);
    const stunPage = attemptPage(
        WEBRTC_STUN.page({ address: witness, frameHostOrigin: "", workerScriptPath: "" }),
    );
    server = await startFixtureServer(
        join(FIXTURES, "capability-app"),
        undefined,
        new Map([
            [
                STUN_PATH,
                () => ({
                    headers: { "content-type": "text/html; charset=utf-8" },
                    body: stunPage,
                }),
            ],
        ]),
    );
});
after(async () => {
    await server.close();
    await witness.close();
});

const isDatagram = (arrival: string): boolean => arrival === Arrival.Datagram;

const READ_COMMAND_LINE = `document.getElementById("command_line")?.textContent ?? ""`;
const READ_ATTEMPT_STATE = `document.querySelector('[data-testid="${ATTEMPT_STATE}"]')?.textContent ?? ""`;

async function withAuditPage<Value>(
    executablePath: string,
    use: (page: PageDriver) => Promise<Value>,
): Promise<Value> {
    const browser: Browser = await launchBrowser(executablePath);
    try {
        const page = await browser.newPage();
        try {
            return await use(page);
        } finally {
            await page.close();
        }
    } finally {
        await browser.close();
    }
}

async function datagramsWithNoPolicy(executablePath: string): Promise<readonly string[]> {
    witness.forgetArrivals();
    const launched = await launchChromium(executablePath, {
        arguments: FLAGS_WITH_NO_WEBRTC_POLICY,
        profilePrefix: "webrtc-with-no-policy-",
    });
    try {
        await launched.connection.ask(undefined, CREATE_TARGET, {
            url: `${server.origin}${STUN_PATH}`,
        });
        await pause(WAIT_AFTER_THE_PAGE_MILLISECONDS);
    } finally {
        await launched.stop();
    }
    return witness.arrivals().filter(isDatagram);
}

async function launchFlagsOfTheAuditBrowser(): Promise<readonly string[]> {
    const text: unknown = await withAuditPage(
        EXECUTABLE_OF_TARGET[BrowserTarget.Chrome],
        async (page) => {
            await page.goto("chrome://version");
            return page.evaluate(READ_COMMAND_LINE);
        },
    );
    assert.ok(typeof text === "string", "the page gave its command line as text");
    return text.split(/\s+/).map((flag) => flag.replace(/^"|"$/g, ""));
}

describe("Using the audit browser", () => {
    for (const targetId of Object.values(BrowserTarget)) {
        describe(`given the audit browser on ${targetId}`, onTarget(targetId), () => {
            describe("and a page that gathers WebRTC candidates from a STUN server", () => {
                describe("when the audit scans it", () => {
                    let datagrams: readonly string[];
                    let attemptState: string;
                    before(async () => {
                        witness.forgetArrivals();
                        attemptState = await withAuditPage(
                            EXECUTABLE_OF_TARGET[targetId],
                            async (page) => {
                                await scan(page, `${server.origin}${STUN_PATH}`, {
                                    page: STUN_PATH,
                                });
                                await pause(WAIT_AFTER_THE_PAGE_MILLISECONDS);
                                return String(await page.evaluate(READ_ATTEMPT_STATE));
                            },
                        );
                        datagrams = witness.arrivals().filter(isDatagram);
                    });

                    test("then it should send that server no datagram", () => {
                        assert.deepEqual(datagrams, []);
                    });

                    test("then it should have run the page's script, so the silence means something", () => {
                        assert.equal(attemptState, ATTEMPT_SETTLED);
                    });
                });

                describe("when a browser launched with no WebRTC policy opens it", () => {
                    test("then it should send that server a datagram, so the audit's silence means something", async () => {
                        const datagrams = await datagramsWithNoPolicy(
                            EXECUTABLE_OF_TARGET[targetId],
                        );
                        assert.ok(datagrams.length > 0, "nothing arrived");
                    });
                });
            });
        });
    }

    // The headless shell has no chrome://version, so only Chrome's flags can be read from inside. The
    // datagram tests above are what cover the shell's flag.
    describe("given the audit browser on Chrome", () => {
        describe("when a page reads the browser's launch flags", () => {
            let flags: readonly string[];
            before(async () => {
                flags = await launchFlagsOfTheAuditBrowser();
            });

            test("then it should send the policy flag Chrome honours", () => {
                assert.ok(
                    flags.includes(`--webrtc-ip-handling-policy=${WEBRTC_POLICY}`),
                    flags.join(" "),
                );
            });

            test("then it should send the policy flag the headless shell honours", () => {
                assert.ok(
                    flags.includes(`--force-webrtc-ip-handling-policy=${WEBRTC_POLICY}`),
                    flags.join(" "),
                );
            });

            test("then it should still show the flags it was launched with, so a missing one means something", () => {
                assert.ok(
                    flags.some((flag) => flag.startsWith("--user-data-dir=")),
                    flags.join(" "),
                );
            });
        });
    });
});
