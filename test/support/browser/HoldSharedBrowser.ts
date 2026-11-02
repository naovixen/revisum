// A test process in miniature, for tests of how shared browsers end: it launches one and says which,
// then either holds it until something kills this process, or stops it and exits by itself.
//   node HoldSharedBrowser.ts <executable> hold|stop
import { sharedBrowserFor, stopSharedBrowsers } from "./ShareBrowserInThisFile.ts";

const HOLD_TICK_MILLISECONDS = 60_000;

const [executablePath = "", mode = ""] = process.argv.slice(2);
const browser = await sharedBrowserFor({ executablePath, locale: "en-GB", proxy: undefined });
const { processId, webSocketUrl } = browser;
process.stdout.write(`${JSON.stringify({ processId, webSocketUrl })}\n`);
if (mode === "stop") {
    await stopSharedBrowsers();
} else {
    setInterval(() => undefined, HOLD_TICK_MILLISECONDS);
}
