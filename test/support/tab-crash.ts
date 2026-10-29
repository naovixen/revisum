// Crashes a tab mid-plan, the way a renderer dies: the fixture page crash.html asks the server for
// a signal file 300 ms after it has loaded, while the plan's next step is waiting, and the test
// then ends every renderer process of the session's browser at once.
import type { CapabilityHarness, WatchedDriver } from './capability-harness.ts';
import { endAtOnce, rendererProcesses } from './process-tree.ts';

export const CRASH_READY_PATH = '/crash-ready.txt';
// A run that never reaches the signal must not leave the test waiting for ever.
const GIVE_UP_MILLISECONDS = 20_000;

// Resolves with how many renderer processes were ended: 0 when the signal never came.
export function crashWhenRequested(harness: CapabilityHarness, watched: WatchedDriver, path: string): Promise<number> {
  const crash = Promise.all([watched.opened(), harness.requested(path)]).then(([browserProcessId]) => {
    const renderers = rendererProcesses(browserProcessId);
    for (const renderer of renderers) endAtOnce(renderer.processId);
    return renderers.length;
  });
  let timer: NodeJS.Timeout | undefined;
  const giveUp = new Promise<number>((resolve) => { timer = setTimeout(() => resolve(0), GIVE_UP_MILLISECONDS); });
  return Promise.race([crash, giveUp]).finally(() => clearTimeout(timer));
}
