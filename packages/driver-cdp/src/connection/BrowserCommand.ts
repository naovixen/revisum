// What the browser sends is input from outside the program, so it is parsed once, as it enters.
// A command and the decoder of its reply travel together, with the parameters it takes in its type, so
// a caller holds a reply only once it has been parsed, and sends only what the command takes. A reply of
// another shape rejects with MalformedBrowserReply; an event of another shape is a failure its listener
// is told. Only what the driver reads is checked, since what the browser adds beyond that says nothing
// either way.
import {
    fieldOf,
    frameTreeAt,
    listAt,
    numberAt,
    optional,
    textAt,
    type MessagePart,
} from "./MessagePart.ts";

export type BrowserCommand<CommandParameters, Reply> = {
    readonly method: string;
    // Only the compiler reads this: it ties what a command takes to the command.
    readonly parameters?: CommandParameters;
    decode(reply: unknown): Reply;
};

// The reply of a command the driver only needs to have been accepted.
export const NOTHING_TO_READ = (): void => undefined;

export const browserCommand =
    <CommandParameters>() =>
    <Reply>(
        method: string,
        readReply: (reply: MessagePart) => Reply,
    ): BrowserCommand<CommandParameters, Reply> => ({
        method,
        decode: (reply) => readReply({ value: reply, method, path: "result" }),
    });

export type NoParameters = Readonly<Record<string, never>>;

// A value handed to a page function: by reference, as a value JSON cannot carry (NaN, a bigint), or as
// undefined, which an empty argument stands for.
export type CallArgument =
    | { readonly value: unknown }
    | { readonly unserializableValue: string }
    | { readonly objectId: string }
    | NoParameters;

// ---- The browser and its targets ----

export const GET_VERSION = browserCommand<NoParameters>()("Browser.getVersion", (reply) => ({
    product: textAt(fieldOf(reply, "product")),
    userAgent: textAt(fieldOf(reply, "userAgent")),
}));

export const CLOSE_BROWSER = browserCommand<NoParameters>()("Browser.close", NOTHING_TO_READ);

export const CREATE_BROWSER_CONTEXT = browserCommand<{
    readonly disposeOnDetach: boolean;
    readonly proxyServer: string;
    readonly proxyBypassList?: string;
}>()("Target.createBrowserContext", (reply) => ({
    browserContextId: textAt(fieldOf(reply, "browserContextId")),
}));

export const GET_BROWSER_CONTEXTS = browserCommand<NoParameters>()(
    "Target.getBrowserContexts",
    (reply) => ({
        browserContextIds: listAt(fieldOf(reply, "browserContextIds"), textAt),
    }),
);

export const CREATE_TARGET = browserCommand<{
    readonly url: string;
    readonly browserContextId?: string;
    readonly newWindow?: boolean;
}>()("Target.createTarget", (reply) => ({ targetId: textAt(fieldOf(reply, "targetId")) }));

export const ATTACH_TO_TARGET = browserCommand<{
    readonly targetId: string;
    readonly flatten: true;
}>()("Target.attachToTarget", (reply) => ({ sessionId: textAt(fieldOf(reply, "sessionId")) }));

export const CLOSE_TARGET = browserCommand<{ readonly targetId: string }>()(
    "Target.closeTarget",
    NOTHING_TO_READ,
);

export const SET_AUTO_ATTACH = browserCommand<{
    readonly autoAttach: true;
    readonly waitForDebuggerOnStart: true;
    readonly flatten: true;
    readonly filter: readonly { readonly type: string }[];
}>()("Target.setAutoAttach", NOTHING_TO_READ);

export const SET_PERMISSION = browserCommand<{
    readonly permission: { readonly name: string };
    readonly setting: "granted" | "denied";
    readonly origin?: string;
    readonly browserContextId: string;
}>()("Browser.setPermission", NOTHING_TO_READ);

export const SET_DOWNLOAD_BEHAVIOUR = browserCommand<{
    readonly behavior: "deny" | "allowAndName";
    readonly downloadPath?: string;
    readonly browserContextId: string;
    readonly eventsEnabled: true;
}>()("Browser.setDownloadBehavior", NOTHING_TO_READ);

export const CANCEL_DOWNLOAD = browserCommand<{
    // The quoted key is the protocol's own parameter name.
    readonly "guid": string;
    readonly browserContextId: string;
}>()("Browser.cancelDownload", NOTHING_TO_READ);

// ---- Domains of a page ----

export const ENABLE_PAGE = browserCommand<NoParameters>()("Page.enable", NOTHING_TO_READ);
export const ENABLE_INSPECTOR = browserCommand<NoParameters>()("Inspector.enable", NOTHING_TO_READ);
export const ENABLE_RUNTIME = browserCommand<NoParameters>()("Runtime.enable", NOTHING_TO_READ);
export const ENABLE_NETWORK = browserCommand<NoParameters>()("Network.enable", NOTHING_TO_READ);
export const ENABLE_DOM = browserCommand<NoParameters>()("DOM.enable", NOTHING_TO_READ);
export const ENABLE_CSS = browserCommand<NoParameters>()("CSS.enable", NOTHING_TO_READ);
export const ENABLE_ACCESSIBILITY = browserCommand<NoParameters>()(
    "Accessibility.enable",
    NOTHING_TO_READ,
);

export const SET_DEVICE_METRICS = browserCommand<{
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor: number;
    readonly mobile: boolean;
}>()("Emulation.setDeviceMetricsOverride", NOTHING_TO_READ);

export const SET_TOUCH_EMULATION = browserCommand<{
    readonly enabled: true;
    // The quoted key is the protocol's own parameter name.
    readonly "maxTouchPoints": number;
}>()("Emulation.setTouchEmulationEnabled", NOTHING_TO_READ);

export const SET_LOCALE = browserCommand<{ readonly locale: string }>()(
    "Emulation.setLocaleOverride",
    NOTHING_TO_READ,
);

export const SET_TIME_ZONE = browserCommand<{ readonly timezoneId: string }>()(
    "Emulation.setTimezoneOverride",
    NOTHING_TO_READ,
);

export const SET_USER_AGENT = browserCommand<{
    readonly userAgent: string;
    readonly acceptLanguage: string;
}>()("Emulation.setUserAgentOverride", NOTHING_TO_READ);

export const SET_EMULATED_MEDIA = browserCommand<{
    readonly features: readonly { readonly name: string; readonly value: string }[];
}>()("Emulation.setEmulatedMedia", NOTHING_TO_READ);

export const SET_FOCUS_EMULATION = browserCommand<{ readonly enabled: true }>()(
    "Emulation.setFocusEmulationEnabled",
    NOTHING_TO_READ,
);

export const SET_SCRIPT_EXECUTION_DISABLED = browserCommand<{ readonly value: boolean }>()(
    "Emulation.setScriptExecutionDisabled",
    NOTHING_TO_READ,
);

export const ADD_SCRIPT_ON_NEW_DOCUMENT = browserCommand<{
    readonly source: string;
    readonly worldName?: string;
}>()("Page.addScriptToEvaluateOnNewDocument", (reply) => ({
    identifier: textAt(fieldOf(reply, "identifier")),
}));

export const REMOVE_SCRIPT_ON_NEW_DOCUMENT = browserCommand<{ readonly identifier: string }>()(
    "Page.removeScriptToEvaluateOnNewDocument",
    NOTHING_TO_READ,
);

export const ADD_BINDING = browserCommand<{
    readonly name: string;
    readonly executionContextName: string;
}>()("Runtime.addBinding", NOTHING_TO_READ);

// The browser names the frame it sent to the address: a reply with no error and no frame would
// otherwise read as a navigation that went on.
export const NAVIGATE = browserCommand<{ readonly url: string; readonly frameId?: string }>()(
    "Page.navigate",
    (reply) => ({
        frameId: textAt(fieldOf(reply, "frameId")),
        errorText: optional(fieldOf(reply, "errorText"), textAt),
    }),
);

export const BRING_TO_FRONT = browserCommand<NoParameters>()("Page.bringToFront", NOTHING_TO_READ);

export const GET_FRAME_TREE = browserCommand<NoParameters>()("Page.getFrameTree", (reply) => ({
    frameTree: frameTreeAt(fieldOf(reply, "frameTree")),
}));

export const CREATE_ISOLATED_WORLD = browserCommand<{
    readonly frameId: string;
    readonly worldName: string;
}>()("Page.createIsolatedWorld", (reply) => ({
    executionContextId: numberAt(fieldOf(reply, "executionContextId")),
}));

export const HANDLE_DIALOG = browserCommand<{ readonly accept: boolean }>()(
    "Page.handleJavaScriptDialog",
    NOTHING_TO_READ,
);

export const CAPTURE_SCREENSHOT = browserCommand<{
    readonly format: "png";
    readonly clip?: {
        readonly x: number;
        readonly y: number;
        readonly width: number;
        readonly height: number;
        readonly scale: number;
    };
    readonly captureBeyondViewport?: false;
    readonly fromSurface?: true;
}>()("Page.captureScreenshot", (reply) => ({ data: textAt(fieldOf(reply, "data")) }));

export const GET_LAYOUT_METRICS = browserCommand<NoParameters>()(
    "Page.getLayoutMetrics",
    (reply) => {
        const viewport = fieldOf(reply, "cssLayoutViewport");
        return {
            cssLayoutViewport: {
                clientWidth: numberAt(fieldOf(viewport, "clientWidth")),
                clientHeight: numberAt(fieldOf(viewport, "clientHeight")),
            },
        };
    },
);
