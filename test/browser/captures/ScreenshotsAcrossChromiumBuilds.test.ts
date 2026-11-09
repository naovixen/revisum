// Chrome otherwise rasters on the GPU with partial raster, so a screenshot's bytes depend on the
// frames before it: a run's capture can differ from the last by a few pixels, and Chrome's from the
// headless shell's. With the GPU off, the two builds of one version draw the same page the same way.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { defaultRedactor, type SessionEnvironment } from "@revisum/engine";
import type { BrowserHarness, BrowserRun } from "#test-support/browser/BrowserHarness.ts";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { driverForTarget } from "#test-support/browser/driver/CreateBrowserDriver.ts";
import { decodePng, type DecodedImage } from "#test-support/builders/DecodePng.ts";
import {
    FIXED_TIME_MILLISECONDS,
    SEED,
    signupHarness,
    signupPlan,
} from "#test-support/browser/harnesses/SignupHarness.ts";
import { fullTierOnly } from "#test-support/TestTier.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";
import { baseUrlOf } from "#test-support/builders/ClearRun.ts";

const SOFTWARE_RASTER_FLAG = "--disable-gpu";
const HEADLESS_FLAG = "--headless";
const CAPTURE_WITH_NO_HOVER = "form-filled";

let harness: BrowserHarness;
before(async () => {
    harness = await signupHarness();
});
after(async () => {
    await harness.close();
});

function readCommandLineText(): string {
    return document.getElementById("command_line")?.textContent ?? "";
}

// chrome://version shows the command line as one string, and may quote an argument.
const splitCommandLine = (text: string): readonly string[] =>
    text
        .split(/\s+/)
        .filter((argument) => argument !== "")
        .map((argument) => argument.replace(/^"|"$/g, ""));

async function commandLineOfAChromeSession(): Promise<readonly string[]> {
    const environment: SessionEnvironment = {
        baseUrl: baseUrlOf(harness.server.origin),
        allowedOrigins: harness.project.origins,
        seed: SEED,
        fixedTimeMilliseconds: FIXED_TIME_MILLISECONDS,
        sensitiveSelectors: defaultRedactor().selectors,
        timeoutMilliseconds: 5000,
    };
    const opened = await driverForTarget(BrowserTarget.Chrome).open(
        harness.target(BrowserTarget.Chrome),
        environment,
    );
    assert.ok(opened.ok, "the session opens");
    try {
        const navigated = await opened.value.navigate("chrome://version", scriptsEnabled);
        assert.ok(navigated.ok, JSON.stringify(navigated));
        return splitCommandLine(await opened.value.evaluate(readCommandLineText));
    } finally {
        await opened.value.close();
    }
}

const runOfTheSignupPlan = async (targetId: BrowserTarget): Promise<BrowserRun> => {
    const ran = await harness.run(harness.plan(signupPlan([targetId])), targetId);
    assert.equal(ran.result.state, "Passed", JSON.stringify(ran.result.steps));
    return ran;
};

function bytesOfCapture(ran: BrowserRun, targetId: BrowserTarget): Uint8Array {
    const bytes = ran.store.get(`${targetId}/${CAPTURE_WITH_NO_HOVER}.png`);
    assert.ok(bytes !== undefined, `${targetId} captured ${CAPTURE_WITH_NO_HOVER}`);
    return bytes;
}

const sha256Of = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function distinctColours(image: DecodedImage): number {
    const colours = new Set<string>();
    for (let start = 0; start < image.data.length; start += image.channels) {
        colours.add(image.data.subarray(start, start + image.channels).join(","));
    }
    return colours.size;
}

describe("Using a browser session", () => {
    describe("given Chrome for Testing", () => {
        describe("when a page reads the browser's command line", () => {
            let commandLine: readonly string[];
            before(async () => {
                commandLine = await commandLineOfAChromeSession();
            });

            test("then it should show the browser was launched with the GPU off", () => {
                assert.ok(commandLine.includes(SOFTWARE_RASTER_FLAG), commandLine.join(" "));
            });

            test("then it should show the headless flag too, so a missing flag means something", () => {
                assert.ok(commandLine.includes(HEADLESS_FLAG), commandLine.join(" "));
            });
        });
    });

    describe(
        "given the sign-up plan run on Chrome for Testing and on the headless shell",
        fullTierOnly("it compares with the headless shell, which only the full tier runs"),
        () => {
            describe("when the capture of the filled form, which has no hover, is read from each", () => {
                let onChrome: Uint8Array;
                let onHeadlessShell: Uint8Array;
                before(async () => {
                    onChrome = bytesOfCapture(
                        await runOfTheSignupPlan(BrowserTarget.Chrome),
                        BrowserTarget.Chrome,
                    );
                    onHeadlessShell = bytesOfCapture(
                        await runOfTheSignupPlan(BrowserTarget.HeadlessShell),
                        BrowserTarget.HeadlessShell,
                    );
                });

                test("then it should find the two captures identical, byte for byte", () => {
                    assert.equal(sha256Of(onChrome), sha256Of(onHeadlessShell));
                });

                test("then it should find a drawn page in them, so identical blanks can't pass", () => {
                    assert.ok(distinctColours(decodePng(onChrome)) > 1);
                });
            });
        },
    );
});
