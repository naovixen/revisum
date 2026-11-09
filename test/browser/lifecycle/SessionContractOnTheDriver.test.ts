// The real driver against the behaviour the fake session is held to in test/unit, so the fake a run's
// tests rely on cannot drift from what a browser does.
import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { after, afterEach, before, describe } from "node:test";
import type { Session } from "@revisum/engine";
import { BrowserTarget } from "#test-support/browser/BrowserTarget.ts";
import { isHeldByADialog } from "#test-support/IsHeldByADialog.ts";
import { capabilityHarness, type CapabilityHarness } from "#test-support/browser/harnesses/CapabilityHarness.ts";
import type { FixtureRoute } from "#test-support/builders/FixtureServer.ts";
import { sessionContract } from "#test-support/session-contract/SessionContract.ts";
import { scriptsEnabled } from "#test-support/browser/ScriptsEnabled.ts";

const STEP_TIMEOUT_MILLISECONDS = 1000;
const DIALOG_POLL_MILLISECONDS = 10;
const PAGE_PATH = "/session-contract.html";

const PAGE: FixtureRoute = () => ({
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Contract</title></head><body><main>
      <label for="name">Name</label><input id="name" type="text" autocomplete="off">
      <button type="button">Export</button>
    </main></body></html>`,
});

// Opens the dialog from a timer, long enough for the script's own answer to get out first: a dialog
// open while the answer is on its way fails the script with dialog-open.
const DIALOG_DELAY_MILLISECONDS = 200;
const scriptOpeningADialog = (text: string): string =>
    `() => { setTimeout(() => confirm(${JSON.stringify(text)}), ${DIALOG_DELAY_MILLISECONDS}); return 1; }`;

async function untilADialogIsOpen(session: Session): Promise<void> {
    const deadline = Date.now() + STEP_TIMEOUT_MILLISECONDS;
    while (!(await isHeldByADialog(session))) {
        assert.ok(Date.now() < deadline, "the page opens its dialog");
        await pause(DIALOG_POLL_MILLISECONDS);
    }
}

let harness: CapabilityHarness;
before(async () => {
    harness = await capabilityHarness(
        STEP_TIMEOUT_MILLISECONDS,
        new Map<string, FixtureRoute>([[PAGE_PATH, PAGE]]),
    );
});
after(async () => {
    await harness.close();
});

let opened: Session[] = [];
afterEach(async () => {
    await Promise.all(opened.map((session) => session.close()));
    opened = [];
});

describe("Using the real driver as a session", () => {
    sessionContract(async () => {
        const session = await harness.open(BrowserTarget.Chrome);
        opened.push(session);
        const pageUrl = `${harness.origin}${PAGE_PATH}`;
        const loaded = await session.navigate(pageUrl, scriptsEnabled);
        assert.ok(loaded.ok, JSON.stringify(loaded));
        return {
            session,
            pageUrl,
            openDialog: async (text) => {
                const ran = await session.runScript({
                    source: scriptOpeningADialog(text),
                    arguments: {},
                    timeoutMilliseconds: STEP_TIMEOUT_MILLISECONDS,
                    maximumResultBytes: 16,
                });
                assert.ok(ran.ok, JSON.stringify(ran));
                await untilADialogIsOpen(session);
            },
        };
    });
});
