// What is still running of a browser on Windows once it has been stopped. Each profile folder is made for
// one launch, and Chromium names it on the command line of every process it starts, so a process that
// names it came from that launch. A process holds files in the folder until Windows has ended it, and
// Windows signals a process as ended only once it has closed every handle the process held and unmapped
// its memory. So waiting on each such process's own handle until it is signalled is waiting for the
// folder to be released, and nothing has to try the folder to find out.
import { spawn } from "node:child_process";
import { join } from "node:path";

const LISTING_LIMIT_MILLISECONDS = 5_000;
const FOLDER_VARIABLE = "PROFILE_FOLDER_TO_FIND";
const BROWSER_VARIABLE = "BROWSER_PROCESS_ID";
const STOP_STARTED_VARIABLE = "STOP_STARTED_AT";
const GRACE_VARIABLE = "GRACE_MILLISECONDS";
const PROCESS_ID = /^\d+$/;

// The browser a stop is ending, and when the stop began, in milliseconds since the epoch.
export type StoppingBrowser = { readonly processId: number; readonly stopStartedAt: number };

// What the listing is told goes through the environment, so no folder name can be read as PowerShell, and
// the listing's own command line does not name the folder. A process id the listed process no longer holds
// belongs to another process by then, one started later, so it is passed over: it is not the browser's,
// and must not be ended or waited for. WaitForExit waits on the process's handle. A process that ends
// between the listing and the opening of it leaves behind an error that was caught, for which PowerShell
// would exit with 1, so the listing says outright that it has finished.
const LISTING_COMMAND = [
    "$ErrorActionPreference = 'Stop'",
    `$waitUntil = [DateTime]::UtcNow.AddMilliseconds([int]$env:${GRACE_VARIABLE})`,
    `$stopStartedAt = [DateTimeOffset]::FromUnixTimeMilliseconds([long]$env:${STOP_STARTED_VARIABLE}).UtcDateTime`,
    `$held = foreach ($listed in Get-CimInstance Win32_Process) {`,
    `  if (-not ($listed.CommandLine -and $listed.CommandLine.Contains($env:${FOLDER_VARIABLE}))) { continue }`,
    "  try { $process = [System.Diagnostics.Process]::GetProcessById([int]$listed.ProcessId); $startedAt = $process.StartTime } catch { continue }",
    "  if ([Math]::Abs(($startedAt - $listed.CreationDate).TotalMilliseconds) -ge 1) { continue }",
    `  $isStartedDuringTheStop = $listed.ParentProcessId -eq [int]$env:${BROWSER_VARIABLE} -and $startedAt.ToUniversalTime() -ge $stopStartedAt`,
    "  if ($isStartedDuringTheStop -or $listed.CommandLine.Contains('--type=crashpad-handler')) { try { $process.Kill() } catch { } }",
    "  $process",
    "}",
    "foreach ($process in $held) {",
    "  $left = [Math]::Max(0, [int]($waitUntil - [DateTime]::UtcNow).TotalMilliseconds)",
    '  if (-not $process.WaitForExit($left)) { "$($process.Id)" }',
    "}",
    "exit 0",
].join("\n");

// By its full path, as a stop has to work whatever the PATH holds, which may be why it is here at all.
const powerShellPath = (): string =>
    join(
        process.env["SystemRoot"] ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    );

function decodedProcessIds(output: string): readonly number[] {
    return output
        .split(/\r?\n/)
        .filter((line) => line !== "")
        .map((line) => {
            if (!PROCESS_ID.test(line)) {
                throw new Error("listing the processes gave a line that is not a process id");
            }
            return Number(line);
        });
}

// The ids of what names the folder and still runs once `graceMilliseconds` have passed, waiting until then
// for each to end. A browser's other processes end by themselves soon after it, or with its tree, so they get
// the grace period. Two kinds do not end by themselves in any time a stop can wait. Both are the browser's
// own and of no use without it, so they are ended here, and count as left only if that fails:
// - a crashpad handler, which answers to no job object and under load outlives the browser by half a minute,
//   holding the folder;
// - a process the browser started once the stop had begun. Ending the tree reaches only what ran when
//   taskkill read it, and under load one just started can outlive its browser by more than the grace period.
//   The browser's id is still its own when matched with a process naming its folder, which only this
//   launch's processes do.
// Anything else is not known to be the browser's own, so it is left running, and named. Rejects when the
// system cannot say what is running.
export function windowsProcessesLeft(
    folder: string,
    browser: StoppingBrowser,
    graceMilliseconds: number,
): Promise<readonly number[]> {
    const limit = LISTING_LIMIT_MILLISECONDS + graceMilliseconds;
    return new Promise((resolve, reject) => {
        const listing = spawn(
            powerShellPath(),
            ["-NoProfile", "-NonInteractive", "-Command", LISTING_COMMAND],
            {
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true,
                // Node's own option name.
                ["env"]: {
                    ...process.env,
                    [FOLDER_VARIABLE]: folder,
                    [BROWSER_VARIABLE]: String(browser.processId),
                    [STOP_STARTED_VARIABLE]: String(browser.stopStartedAt),
                    [GRACE_VARIABLE]: String(graceMilliseconds),
                },
            },
        );
        let output = "";
        const timer = setTimeout(() => {
            listing.kill();
            reject(new Error(`listing the processes took longer than ${limit} ms`));
        }, limit);
        listing.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
        });
        listing.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        listing.once("close", (code) => {
            clearTimeout(timer);
            if (code === 0) {
                try {
                    resolve(decodedProcessIds(output));
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            } else {
                reject(new Error(`listing the processes exited with code ${String(code)}`));
            }
        });
    });
}
