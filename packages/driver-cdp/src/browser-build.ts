// Which Chromium build the CDP driver would launch, without launching it, so the engine can pin it
// by hash. The driver runs the executable it was constructed with; it downloads nothing.
// See docs/specs/SPEC-05-target-matrix-and-lock.md.
import { failure, success, type BrowserBuild, type BuildFailure, type Result } from '@revisum/contracts';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

// A Chromium build number, such as 156.0.8078.47.
const CHROMIUM_VERSION = /\d+\.\d+\.\d+\.\d+/g;
// Chromium on Windows keeps a "<version>.manifest" file beside its executable.
const VERSION_MANIFEST = /^(\d+\.\d+\.\d+\.\d+)\.manifest$/;

// The version, read from the path first: Chrome for Testing, as tools/install-browsers.ts installs
// it, lives in a folder named after its build. Running `--version` is avoided on purpose: on
// Windows Chrome prints nothing for it, and it would start the browser on other systems.
function chromiumVersion(executablePath: string): string | null {
  const fromPath = executablePath.match(CHROMIUM_VERSION);
  if (fromPath !== null) return fromPath[fromPath.length - 1] ?? null;
  try {
    for (const name of readdirSync(dirname(executablePath))) {
      const manifest = VERSION_MANIFEST.exec(name);
      if (manifest?.[1] !== undefined) return manifest[1];
    }
  } catch {
    // An unreadable folder tells no version; reported below.
  }
  return null;
}

export function chromiumBuild(executablePath: string): Result<BrowserBuild, BuildFailure> {
  if (!existsSync(executablePath) || !statSync(executablePath).isFile()) {
    return failure({
      code: 'lock-download-failed',
      detail: `no Chromium executable at ${executablePath}; install the pinned build with npm run browsers`,
    });
  }
  const version = chromiumVersion(executablePath);
  if (version === null) {
    return failure({ code: 'launch-failed', detail: `cannot tell the Chromium version of ${executablePath} from its path` });
  }
  return success({ version, executablePath });
}
