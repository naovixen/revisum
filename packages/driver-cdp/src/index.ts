// Public entry point: the own Chromium driver over the Chrome DevTools Protocol, and the CDP
// connection and launcher that the accessibility engine also uses.
export { cdpDriver, CDP_ADAPTER_VERSION, type CdpDriverOptions } from './cdp-driver.ts';
export {
  CdpConnection, CdpError, DEFAULT_COMMAND_TIMEOUT_MILLISECONDS, type CdpSessionClient, type ConnectOptions,
} from './cdp-connection.ts';
export { ISOLATED_CHROMIUM_ARGUMENTS, launchChromium, type LaunchedChromium, type LaunchOptions } from './chromium-launcher.ts';
export { PAGE_AUDIT_RULE_IDS, type AuditNode, type AuditRuleResult } from './page-audit.ts';
export type { DriverSession, OwnBrowserDriver } from './page-operations.ts';
