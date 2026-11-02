// Public entry point: the own Chromium driver over the Chrome DevTools Protocol, and the CDP
// connection and launcher that the accessibility engine also uses.
export { cdpDriver, type CdpDriverOptions } from './cdp-driver.ts';
export { heldModifierKeys } from './modifier-keys.ts';
export { CdpConnection, DEFAULT_COMMAND_TIMEOUT_MILLISECONDS, type CdpSessionClient } from './cdp-connection.ts';
export { launchChromium, type LaunchedChromium } from './chromium-launcher.ts';
export type { DriverSession, OwnBrowserDriver } from './page-operations.ts';
