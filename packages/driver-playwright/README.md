# driver-playwright

Fallback driver for Chromium, Firefox and WebKit, built on Playwright, kept until the cdp driver passes every capability test. It refuses hover, select, upload, frame and dialog steps with `unsupported-step`. Of the optional plan features it declares only plan 1.3's page parts: CSS and XPath locators (with `hasText` and `inside`), DOM checks, and page scripts, run in the page's main world with their arguments as one JSON object and raced against their timeout.

It imports `contracts`, Node built-ins, `playwright-core` 1.64.1 and the unmodified `axe-core` 4.14.0 bundle for its audit step (see `docs/decisions/browser-and-audit-dependencies.md`). Licence: Apache-2.0.
