// Public entry point: the own Chromium driver over the Chrome DevTools Protocol, and the CDP
// connection and launcher that the accessibility engine also uses.
export { cdpDriver, type CdpDriverOptions } from './cdp-driver.ts';
export { egressThroughExistingProxy, type ConnectionFailure, type EgressSource, type RefusalReader, type SessionEgress } from './SessionEgress.ts';
export { heldModifierKeys } from './modifier-keys.ts';
export { CdpConnection, DEFAULT_COMMAND_TIMEOUT_MILLISECONDS, type CdpSessionClient } from './cdp-connection.ts';
// The commands and events the accessibility engine sends and reads, each with its reply's decoder.
export { ATTACH_TO_TARGET, BRING_TO_FRONT, CAPTURE_SCREENSHOT, CLOSE_TARGET, CREATE_TARGET, ENABLE_ACCESSIBILITY, ENABLE_CSS, ENABLE_DOM, ENABLE_PAGE, ENABLE_RUNTIME, GET_FRAME_TREE, GET_LAYOUT_METRICS, GET_VERSION, NAVIGATE, SET_DEVICE_METRICS, SET_FOCUS_EMULATION, type AccessibilityTreeNode, type FrameTree } from './BrowserCommand.ts';
export { CALL_FUNCTION_ON, CAPTURE_SNAPSHOT, DESCRIBE_NODE, EVALUATE, GET_DOCUMENT, GET_FULL_ACCESSIBILITY_TREE, GET_MATCHED_STYLES, PUSH_NODES_BY_BACKEND_IDS, RELEASE_OBJECT, RESOLVE_NODE } from './CallFunctionOn.ts';
export { CONTINUE_REQUEST, DISPATCH_KEY_EVENT, ENABLE_REQUEST_HOLDING, FAIL_REQUEST } from './DispatchMouseEvent.ts';
export { REQUEST_PAUSED } from './BrowserEvent.ts';
export { launchChromium, type LaunchedChromium } from './chromium-launcher.ts';
export type { DriverSession, OwnBrowserDriver } from './page-operations.ts';
// For tests only, to save a launch per run. Production keeps a fresh browser per run, because
// isolation between runs matters more than speed: all the sessions on a shared browser have one
// process, one clipboard and one set of launch flags.
export { launchSharedBrowser, type BrowserSource, type LaunchedSharedBrowser, type SharedBrowser } from './SharedBrowser.ts';
