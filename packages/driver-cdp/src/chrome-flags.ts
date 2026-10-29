// Chromium command-line flags for a driver session. They stop background traffic and first-run
// screens and keep pixels stable. Network access is limited by request interception in the
// driver, so blocked origins can be recorded as evidence.

// The Chromium feature that asks Windows for a random local port on every connection
// (SO_RANDOMIZE_PORT). Windows then fails about one connect in sixty with WSAENOBUFS, seen as
// net::ERR_NO_BUFFER_SPACE: a page or one of its files fails to load even on 127.0.0.1, so runs
// and screenshots differ. With the feature off, Windows picks the port as it does for every other
// program. Chromium reads only the last --disable-features flag, so this name joins each list.
export const PORT_RANDOMISATION_FEATURE = 'TcpPortRandomizationWin';

export const QUIET_CHROME_FLAGS: readonly string[] = [
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
  `--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,InterestFeedContentSuggestions,CalculateNativeWinOcclusion,${PORT_RANDOMISATION_FEATURE}`,
  '--metrics-recording-only',
  '--mute-audio',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--password-store=basic',
  '--use-mock-keychain',
];

// Flags that send every request through an HTTP proxy. Chromium sends 127.0.0.1 and localhost
// direct unless "<-loopback>" removes them from its built-in bypass list.
export function proxyFlags(proxy: { readonly server: string; readonly includeLoopback: boolean }): readonly string[] {
  return [`--proxy-server=${proxy.server}`, ...(proxy.includeLoopback ? ['--proxy-bypass-list=<-loopback>'] : [])];
}
