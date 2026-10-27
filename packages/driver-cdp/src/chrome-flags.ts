// Chromium command-line flags for a driver session. They stop background traffic and first-run
// screens and keep pixels stable. Network access is limited by request interception in the
// driver, so blocked origins can be recorded as evidence.
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
  '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,InterestFeedContentSuggestions,CalculateNativeWinOcclusion',
  '--metrics-recording-only',
  '--mute-audio',
  '--hide-scrollbars',
  '--force-color-profile=srgb',
  '--password-store=basic',
  '--use-mock-keychain',
];
