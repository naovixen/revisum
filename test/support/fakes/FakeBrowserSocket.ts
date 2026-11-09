// Stands where the socket to a browser would, under a real CdpConnection, so the whole driver runs
// with no browser. It answers every command as a healthy browser would, enough to open a session and
// its tabs, until a page's target is closed. From then on, as Chromium may in the moment before a
// closed tab detaches, it answers nothing sent to that page and never says the page has gone.
import { scriptResultText } from "../../../packages/driver-cdp/src/in-page/ScriptResultText.ts";

export const FAKE_SCRIPT_RESULT = "answered";

const BROWSER_CONTEXT_ID = "fake-browser-context";
const TEXT_OF_A_PAGE_FUNCTION = { result: { type: "string", value: FAKE_SCRIPT_RESULT } };
const TEXT_OF_A_SCRIPT_RESULT = {
    result: { type: "object", value: ["text", FAKE_SCRIPT_RESULT] },
};

const REPLIES: Readonly<Record<string, unknown>> = {
    "Browser.getVersion": { product: "Chrome/1.0.0.0", userAgent: "a fake browser" },
    "Target.createBrowserContext": { browserContextId: BROWSER_CONTEXT_ID },
    "Page.addScriptToEvaluateOnNewDocument": { identifier: "fake-script" },
    "Page.getFrameTree": { frameTree: { frame: { id: "fake-frame", url: "about:blank" } } },
    "Page.createIsolatedWorld": { executionContextId: 1 },
    "Runtime.evaluate": { result: { type: "object", objectId: "fake-document" } },
};

type Command = {
    readonly id: number;
    readonly method: string;
    readonly sessionId: string | undefined;
    readonly parameters: Readonly<Record<string, unknown>>;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

function commandIn(data: unknown): Command {
    const parsed: unknown = typeof data === "string" ? JSON.parse(data) : null;
    if (!isRecord(parsed)) {
        throw new Error("the driver sent something that is no command");
    }
    const { id, method, sessionId, params } = parsed;
    if (
        typeof id !== "number" ||
        typeof method !== "string" ||
        !(sessionId === undefined || typeof sessionId === "string")
    ) {
        throw new Error(`the driver sent a command of another shape: ${String(data)}`);
    }
    return { id, method, sessionId, parameters: isRecord(params) ? params : {} };
}

export class FakeBrowserSocket extends EventTarget implements WebSocket {
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    readonly bufferedAmount = 0;
    readonly extensions = "";
    readonly protocol = "";
    readonly readyState = 1;
    readonly url = "ws://fake-browser/";
    binaryType: "blob" | "arraybuffer" = "blob";
    onclose = null;
    onerror = null;
    onmessage = null;
    onopen = null;
    readonly #sessionOfTarget = new Map<string, string>();
    readonly #closedSessions = new Set<string>();
    readonly #sentToClosedPages: string[] = [];

    // The method of every command sent to a page after its target closed.
    commandsSentToClosedPages(): readonly string[] {
        return [...this.#sentToClosedPages];
    }

    send(data: unknown): void {
        const command = commandIn(data);
        if (command.sessionId !== undefined && this.#closedSessions.has(command.sessionId)) {
            this.#sentToClosedPages.push(command.method);
            return;
        }
        queueMicrotask(() => {
            this.#answer(command);
        });
    }

    close(): void {
        queueMicrotask(() => {
            this.dispatchEvent(new Event("close"));
        });
    }

    #answer(command: Command): void {
        switch (command.method) {
            case "Target.createTarget": {
                this.#openPage(command);
                return;
            }
            case "Target.attachToTarget": {
                const targetId = String(command.parameters["targetId"]);
                this.#reply(command, { sessionId: this.#sessionOfTarget.get(targetId) });
                return;
            }
            case "Target.closeTarget": {
                const sessionId = this.#sessionOfTarget.get(String(command.parameters["targetId"]));
                if (sessionId !== undefined) {
                    this.#closedSessions.add(sessionId);
                }
                this.#reply(command, {});
                return;
            }
            case "Page.navigate": {
                this.#reply(command, { frameId: "fake-frame" });
                this.#tell({ method: "Page.loadEventFired", sessionId: command.sessionId });
                return;
            }
            case "Runtime.callFunctionOn": {
                this.#reply(
                    command,
                    command.parameters["functionDeclaration"] === scriptResultText.toString()
                        ? TEXT_OF_A_SCRIPT_RESULT
                        : TEXT_OF_A_PAGE_FUNCTION,
                );
                return;
            }
            default:
                this.#reply(command, REPLIES[command.method] ?? {});
        }
    }

    // The session's first page is attached when the driver asks; every later one is attached by the
    // browser itself, and told of as an event, since the driver set that up.
    #openPage(command: Command): void {
        const pageNumber = this.#sessionOfTarget.size + 1;
        const targetId = `fake-target-${pageNumber}`;
        const sessionId = `fake-session-${pageNumber}`;
        this.#sessionOfTarget.set(targetId, sessionId);
        this.#reply(command, { targetId });
        if (pageNumber > 1) {
            this.#tell({
                method: "Target.attachedToTarget",
                params: {
                    sessionId,
                    waitingForDebugger: true,
                    targetInfo: { targetId, type: "page", browserContextId: BROWSER_CONTEXT_ID },
                },
            });
        }
    }

    #reply(command: Command, result: unknown): void {
        this.#tell({ id: command.id, result });
    }

    #tell(message: Readonly<Record<string, unknown>>): void {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
    }
}
