// For tests only: the launchers a production run must never reach, which tools/repo-rules/code/CheckCompositionRoot.ts
// keeps out of the packages. Production keeps a fresh browser per run, because isolation between runs
// matters more than speed: all the sessions on a shared browser have one process, one clipboard and
// one set of launch flags. Flags of the caller's own would loosen what isolates a run's browser.
export { launchChromiumWithArguments } from "../launch/LaunchChromium.ts";
export { launchSharedBrowser } from "../launch/SharedBrowser.ts";
