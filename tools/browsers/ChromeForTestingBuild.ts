// Installs the browsers the browser tests drive, always run headless.
// Chrome for Testing, pinned below, and its headless shell from the same build (the build CI's
// contract suite also runs on), into .browsers/ at the repository root (the cache layout
// test/support/browser/Browsers.ts reads). The evidence workload's test suite uses playwright-core with
// that headless shell, so no Playwright-owned browser is installed.
// Installing twice is quick: a build already in the cache is not downloaded again.
//   node tools/browsers/ChromeForTestingBuild.ts
// See docs/decisions/browser-and-audit-dependencies.md.
import { Browser, computeExecutablePath, detectBrowserPlatform, install } from '@puppeteer/browsers';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep in step with CHROME_BUILD in test/support/browser/Browsers.ts.
export const CHROME_FOR_TESTING_BUILD = '156.0.8078.47';

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const cacheFolder = join(repositoryRoot, '.browsers');

// Chrome for Testing itself, or its headless shell: the same build without a window system.
async function installChromeForTesting(browser: Browser.CHROME | Browser.CHROMEHEADLESSSHELL): Promise<string> {
  const platform = detectBrowserPlatform();
  if (platform === undefined) {throw new Error('Chrome for Testing has no build for this operating system');}
  const executablePath = computeExecutablePath({ browser, buildId: CHROME_FOR_TESTING_BUILD, cacheDir: cacheFolder, platform });
  if (existsSync(executablePath)) {return executablePath;}
  const installed = await install({ browser, buildId: CHROME_FOR_TESTING_BUILD, cacheDir: cacheFolder, platform });
  return installed.executablePath;
}

async function main(): Promise<number> {
  const chrome = await installChromeForTesting(Browser.CHROME);
  console.log(`Chrome for Testing ${CHROME_FOR_TESTING_BUILD}: ${chrome}`);
  const headlessShell = await installChromeForTesting(Browser.CHROMEHEADLESSSHELL);
  console.log(`Chrome for Testing headless shell ${CHROME_FOR_TESTING_BUILD}: ${headlessShell}`);
  return 0;
}

if (import.meta.main) {process.exitCode = await main();}
