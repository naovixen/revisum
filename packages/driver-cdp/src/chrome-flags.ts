// Chromium command-line flags for a driver session. They stop background traffic and first-run
// screens and keep pixels stable. Network access is limited by the session's egress proxy and by
// request interception in the driver, so blocked origins can be recorded as evidence.

// The Chromium feature that asks Windows for a random local port on every connection
// (SO_RANDOMIZE_PORT). Windows then fails about one connect in sixty with WSAENOBUFS, seen as
// net::ERR_NO_BUFFER_SPACE: a page or one of its files fails to load even on 127.0.0.1, so runs
// and screenshots differ. With the feature off, Windows picks the port as it does for every other
// program. Chromium reads only the last --disable-features flag, so this name joins each list.
export const PORT_RANDOMISATION_FEATURE = 'TcpPortRandomizationWin';

const quietChromeFlags = (furtherFeaturesOff: readonly string[]): readonly string[] => [
  '--headless',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-default-apps',
  '--disable-sync',
  '--disable-extensions',
  '--disable-breakpad',
  '--disable-client-side-phishing-detection',
  '--disable-domain-reliability',
  `--disable-features=${['Translate', 'OptimizationHints', 'MediaRouter', 'AutofillServerCommunication', 'InterestFeedContentSuggestions', 'CalculateNativeWinOcclusion', PORT_RANDOMISATION_FEATURE, ...furtherFeaturesOff].join(',')}`,
  '--metrics-recording-only',
  '--mute-audio',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--password-store=basic',
  '--use-mock-keychain',
];

export const QUIET_CHROME_FLAGS = quietChromeFlags([]);

// Creating a browser context otherwise sends one request of Chrome's own through that context's proxy.
const NEW_CONTEXT_REQUEST_FEATURE = 'AimEnabled';
const WEBRTC_POLICY = 'disable_non_proxied_udp';

// For a browser whose sessions each have an egress proxy on their context. Chrome's own traffic goes to
// the browser-wide proxy, which leads nowhere. Chrome honours only the first WebRTC flag and the
// headless shell only the second.
export const sessionEgressChromeFlags = (deadProxyServer: string): readonly string[] => [
  ...quietChromeFlags([NEW_CONTEXT_REQUEST_FEATURE]),
  `--proxy-server=${deadProxyServer}`,
  `--webrtc-ip-handling-policy=${WEBRTC_POLICY}`,
  `--force-webrtc-ip-handling-policy=${WEBRTC_POLICY}`,
];

// Takes 127.0.0.1, localhost and link-local addresses out of Chromium's built-in bypass list.
export const LOOPBACK_THROUGH_PROXY = '<-loopback>';

// The egress proxy every request goes through, such as the isolated runner's. includeLoopback
// sends requests to 127.0.0.1 and localhost through it too; without it they go direct.
export type ProxySettings = { readonly server: string; readonly includeLoopback: boolean };

// Flags that send every request through an HTTP proxy.
export function proxyFlags(proxy: ProxySettings): readonly string[] {
  return [`--proxy-server=${proxy.server}`, ...(proxy.includeLoopback ? [`--proxy-bypass-list=${LOOPBACK_THROUGH_PROXY}`] : [])];
}
