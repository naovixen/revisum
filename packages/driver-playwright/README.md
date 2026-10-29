# driver-playwright

Fallback driver for Chromium, Firefox and WebKit, built on Playwright, kept until the cdp driver passes every capability test. It refuses hover, select, upload, frame and dialog steps with `unsupported-step`.

It imports `contracts`, Node built-ins, `playwright-core` 1.64.1 and the unmodified `axe-core` 4.14.0 bundle for its audit step (see `docs/decisions/browser-and-audit-dependencies.md`). Licence: Apache-2.0.
