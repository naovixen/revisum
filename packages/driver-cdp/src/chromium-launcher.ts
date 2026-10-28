// Starts a headless Chromium with a throwaway profile, waits for its DevTools address and
// connects. Stopping it never leaves a process behind, and the profile folder is removed when
// the browser exits.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpConnection, type ConnectOptions } from './cdp-connection.ts';
import { PORT_RANDOMISATION_FEATURE } from './chrome-flags.ts';

// Flags for an isolated, repeatable page: no network outside 127.0.0.1, no first-run UI or
// background traffic, fixed scale factor and font hinting, and no random local ports (see
// chrome-flags.ts). Used by default.
export const ISOLATED_CHROMIUM_ARGUMENTS: readonly string[] = [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
  '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
  '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
  '--force-device-scale-factor=1', '--font-render-hinting=none',
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
  `--disable-features=${PORT_RANDOMISATION_FEATURE}`,
];

export type LaunchOptions = ConnectOptions & {
  // Flags passed to Chromium. The launcher always adds the DevTools port, the profile folder and
  // a blank first page.
  readonly arguments?: readonly string[];
  readonly launchTimeoutMilliseconds?: number;
  readonly profilePrefix?: string;
};

export type LaunchedChromium = {
  readonly connection: CdpConnection;
  readonly browserProcess: ChildProcess;
  readonly webSocketUrl: string;
  readonly userDataFolder: string;
  // Asks the browser to close, forces it after a grace period, and removes the profile folder.
  stop(): Promise<void>;
};

const DEVTOOLS_ANNOUNCEMENT = /DevTools listening on (ws:\/\/\S+)/;
const OUTPUT_LIMIT = 64 * 1024;

// Removes a profile folder, retrying while the browser still holds files. 'maxRetries' is Node's own option name.
function removeFolder(folder: string): void {
  try { rmSync(folder, { recursive: true, force: true, 'maxRetries': 5, retryDelay: 200 }); } catch { /* best effort */ }
}

const hasExited = (child: ChildProcess): boolean => child.exitCode !== null || child.signalCode !== null;

export function launchChromium(executablePath: string, options: LaunchOptions = {}): Promise<LaunchedChromium> {
  const userDataFolder = mkdtempSync(join(tmpdir(), options.profilePrefix ?? 'chromium-profile-'));
  const flags = [
    ...(options.arguments ?? ISOLATED_CHROMIUM_ARGUMENTS),
    '--remote-debugging-port=0', `--user-data-dir=${userDataFolder}`, 'about:blank',
  ];
  const browserProcess = spawn(executablePath, flags, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const exited = new Promise<void>((resolve) => {
    if (hasExited(browserProcess)) resolve();
    browserProcess.once('exit', () => resolve());
    browserProcess.once('error', () => resolve());
  });
  void exited.then(() => removeFolder(userDataFolder));

  const stop = async (connection: CdpConnection | null): Promise<void> => {
    if (connection !== null) await connection.send(undefined, 'Browser.close', {}, 5_000).catch(() => undefined);
    // Wait for a clean exit first; force the process after a grace period.
    const force = setTimeout(() => { try { browserProcess.kill(); } catch { /* already gone */ } }, 3_000);
    if (!hasExited(browserProcess)) await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
    clearTimeout(force);
    if (!hasExited(browserProcess)) {
      browserProcess.kill();
      await exited;
    }
    connection?.close();
    removeFolder(userDataFolder);
  };

  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = options.launchTimeoutMilliseconds ?? 30_000;
    const fail = (error: Error): void => {
      cleanUp();
      void stop(null).then(() => reject(error));
    };
    const timer = setTimeout(() => fail(new Error(`Chromium did not start within ${timeout} ms`)), timeout);
    const onExit = (code: number | null): void => fail(new Error(`Chromium exited during start-up (exit code ${code})`));
    const onError = (error: Error): void => fail(error);
    const onOutput = (chunk: Buffer): void => {
      if (output.length < OUTPUT_LIMIT) output += chunk.toString();
      const match = DEVTOOLS_ANNOUNCEMENT.exec(output);
      if (match === null || match[1] === undefined) return;
      const webSocketUrl = match[1];
      cleanUp();
      CdpConnection.open(webSocketUrl, options).then(
        (connection) => resolve({ connection, browserProcess, webSocketUrl, userDataFolder, stop: () => stop(connection) }),
        (error: unknown) => { void stop(null).then(() => reject(error)); },
      );
    };
    function cleanUp(): void {
      clearTimeout(timer);
      browserProcess.stdout?.off('data', onOutput);
      browserProcess.stderr?.off('data', onOutput);
      // Keep draining the browser's output so a full pipe can never block it.
      browserProcess.stdout?.resume();
      browserProcess.stderr?.resume();
      browserProcess.off('exit', onExit);
      browserProcess.off('error', onError);
    }
    browserProcess.stdout?.on('data', onOutput);
    browserProcess.stderr?.on('data', onOutput);
    browserProcess.once('exit', onExit);
    browserProcess.once('error', onError);
  });
}
