// The pinned browser builds the browser tests drive, always headless.
// Chrome for Testing and its headless shell (the same build without a window system) are read from
// the cache layout of @puppeteer/browsers under .browsers/ at the repository root; CHROME_PATH and
// CHROME_HEADLESS_SHELL_PATH override them. The Playwright fallback driver uses the browsers that
// match its own pinned version.
import { platform } from 'node:os';
import { join } from 'node:path';
import { REPOSITORY_ROOT } from './repository.ts';

export const CHROME_BUILD = '156.0.8078.47';

const cache = join(REPOSITORY_ROOT, '.browsers');
const onWindows = platform() === 'win32';

const pinnedChrome = onWindows
  ? join(cache, 'chrome', `win64-${CHROME_BUILD}`, 'chrome-win64', 'chrome.exe')
  : join(cache, 'chrome', `linux-${CHROME_BUILD}`, 'chrome-linux64', 'chrome');

// The headless shell is installed beside Chrome for Testing, from the same build.
const pinnedHeadlessShell = onWindows
  ? join(cache, 'chrome-headless-shell', `win64-${CHROME_BUILD}`, 'chrome-headless-shell-win64', 'chrome-headless-shell.exe')
  : join(cache, 'chrome-headless-shell', `linux-${CHROME_BUILD}`, 'chrome-headless-shell-linux64', 'chrome-headless-shell');

export const BROWSERS = {
  chrome: process.env['CHROME_PATH'] ?? pinnedChrome,
  chromeHeadlessShell: process.env['CHROME_HEADLESS_SHELL_PATH'] ?? pinnedHeadlessShell,
} as const;
