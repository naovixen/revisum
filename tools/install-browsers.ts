// Installs the browsers the browser tests drive, always run headless:
//   - Chrome for Testing, pinned below, and its headless shell from the same build (the build CI's
//     contract suite also runs on), into .browsers/ at the repository root (the cache layout
//     test/support/browsers.ts reads);
//   - Playwright's own Chromium, Firefox and WebKit builds, pinned by the playwright-core version
//     that driver-playwright depends on.
// Installing twice is quick: a build already in the cache is not downloaded again.
//   node tools/install-browsers.ts
// See docs/decisions/browser-and-audit-dependencies.md.
import { Browser, computeExecutablePath, detectBrowserPlatform, install } from '@puppeteer/browsers';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep in step with CHROME_BUILD in test/support/browsers.ts.
export const CHROME_FOR_TESTING_BUILD = '156.0.8078.47';
const PLAYWRIGHT_BROWSERS = ['chromium', 'firefox', 'webkit'];

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const cacheFolder = join(repositoryRoot, '.browsers');

// Chrome for Testing itself, or its headless shell: the same build without a window system.
async function installChromeForTesting(browser: Browser.CHROME | Browser.CHROMEHEADLESSSHELL): Promise<string> {
  const platform = detectBrowserPlatform();
  if (platform === undefined) throw new Error('Chrome for Testing has no build for this operating system');
  const executablePath = computeExecutablePath({ browser, buildId: CHROME_FOR_TESTING_BUILD, cacheDir: cacheFolder, platform });
  if (existsSync(executablePath)) return executablePath;
  const installed = await install({ browser, buildId: CHROME_FOR_TESTING_BUILD, cacheDir: cacheFolder, platform });
  return installed.executablePath;
}

function installPlaywrightBrowsers(): number {
  // Resolve playwright-core from the driver package that depends on it, so the pinned version is used.
  const requireFromDriver = createRequire(join(repositoryRoot, 'packages', 'driver-playwright', 'package.json'));
  const command = join(dirname(requireFromDriver.resolve('playwright-core/package.json')), 'cli.js');
  const result = spawnSync(process.execPath, [command, 'install', ...PLAYWRIGHT_BROWSERS], { stdio: 'inherit' });
  return result.status ?? 1;
}

async function main(): Promise<number> {
  const chrome = await installChromeForTesting(Browser.CHROME);
  console.log(`Chrome for Testing ${CHROME_FOR_TESTING_BUILD}: ${chrome}`);
  const headlessShell = await installChromeForTesting(Browser.CHROMEHEADLESSSHELL);
  console.log(`Chrome for Testing headless shell ${CHROME_FOR_TESTING_BUILD}: ${headlessShell}`);
  const status = installPlaywrightBrowsers();
  console.log(status === 0 ? `Playwright browsers installed: ${PLAYWRIGHT_BROWSERS.join(', ')}` : 'Playwright browser install failed');
  return status;
}

if (import.meta.main) process.exitCode = await main();
