# driver-cdp

Drives Chromium over the Chrome DevTools Protocol (cdp). This is the default browser driver. It also provides the CDP connection and the Chromium launcher that `auditor-act` scans with.

Besides clicks, fills and presses it hovers, selects, uploads a declared fixture file from the project's fixtures folder, runs steps inside an iframe and answers dialogs, asking the policy gate's runtime guard before each. It reads accessibility states, link targets and the document head, loads a page with scripts off until the next navigate, saves the one file a download step's click starts into a folder of the session's own (removed when the session closes), and opens a second tab in the session's browser context for a newTab step. A tab whose renderer dies fails its step with `target-crashed`; a popup, second page or download no step asked for fails its step with `unsupported-step` and is closed or cancelled. It runs on Chrome for Testing and on its headless shell.

It may import only `contracts` and Node built-ins. Licence: Apache-2.0.
