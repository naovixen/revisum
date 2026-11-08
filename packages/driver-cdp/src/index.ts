// Public entry point: the own Chromium driver over the Chrome DevTools Protocol, and the CDP
// connection and launcher that the accessibility engine also uses.
export { cdpDriver, type CdpDriverOptions } from "./CdpDriver.ts";
export {
    egressThroughExistingProxy,
    type ConnectionFailure,
    type EgressSource,
    type RefusalReader,
    type SessionEgress,
} from "./capabilities/SessionEgress.ts";
export { heldModifierKeys } from "./page/HeldModifierKeys.ts";
export {
    CdpConnection,
    DEFAULT_COMMAND_TIMEOUT_MILLISECONDS,
    type CdpSessionClient,
} from "./connection/CdpConnection.ts";
// The commands and events the accessibility engine sends and reads, each with its reply's decoder.
export {
    ATTACH_TO_TARGET,
    BRING_TO_FRONT,
    CAPTURE_SCREENSHOT,
    CLOSE_TARGET,
    CREATE_TARGET,
    ENABLE_ACCESSIBILITY,
    ENABLE_CSS,
    ENABLE_DOM,
    ENABLE_PAGE,
    ENABLE_RUNTIME,
    GET_FRAME_TREE,
    GET_LAYOUT_METRICS,
    GET_VERSION,
    NAVIGATE,
    SET_DEVICE_METRICS,
    SET_FOCUS_EMULATION,
} from "./connection/BrowserCommand.ts";
export type { AccessibilityTreeNode, FrameTree } from "./connection/RemoteObject.ts";
export { GET_FULL_ACCESSIBILITY_TREE } from "./connection/AccessibilityDomain.ts";
export { GET_MATCHED_STYLES } from "./connection/CssDomain.ts";
export {
    DESCRIBE_NODE,
    GET_DOCUMENT,
    PUSH_NODES_BY_BACKEND_IDS,
    RESOLVE_NODE,
} from "./connection/DomDomain.ts";
export { CAPTURE_SNAPSHOT } from "./connection/DomSnapshotDomain.ts";
export {
    CONTINUE_REQUEST,
    ENABLE_REQUEST_HOLDING,
    FAIL_REQUEST,
} from "./connection/FetchDomain.ts";
export { DISPATCH_KEY_EVENT } from "./connection/InputDomain.ts";
export { CALL_FUNCTION_ON, EVALUATE, RELEASE_OBJECT } from "./connection/RuntimeDomain.ts";
export { LOAD_EVENT_FIRED, REQUEST_PAUSED } from "./connection/BrowserEvent.ts";
export { launchChromium, type LaunchedChromium } from "./launch/LaunchChromium.ts";
export type { DriverSession, OwnBrowserDriver } from "./session/DriverSession.ts";
// For tests only, to save a launch per run. Production keeps a fresh browser per run, because
// isolation between runs matters more than speed: all the sessions on a shared browser have one
// process, one clipboard and one set of launch flags.
export {
    launchSharedBrowser,
    type BrowserSource,
    type LaunchedSharedBrowser,
    type SharedBrowser,
} from "./launch/SharedBrowser.ts";
