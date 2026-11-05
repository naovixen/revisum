// What is still running of a browser on Windows, for when its process tree could not be ended whole. Each
// profile folder is made for one launch, so a process that names it on its command line came from that launch.
import { spawn } from "node:child_process";
import { join } from "node:path";

const LISTING_LIMIT_MILLISECONDS = 5_000;
const CHECK_INTERVAL_MILLISECONDS = 100;
const CRASHPAD_SWITCH = "--type=crashpad-handler";
const FOLDER_VARIABLE = "PROFILE_FOLDER_TO_FIND";
const LISTED_PROCESS = /^(\d+) (.*)$/;

// The folder goes through the environment, so no folder name can be read as PowerShell, and the
// listing's own command line does not name it.
const LISTING_COMMAND = `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:${FOLDER_VARIABLE}) } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine -replace '\\s+', ' ')" }`;

type ListedProcess = { readonly processId: number; readonly commandLine: string };

const pause = (milliseconds: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });

// By its full path, as a stop has to work whatever the PATH holds, which may be why it is here at all.
const powerShellPath = (): string =>
    join(
        process.env["SystemRoot"] ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
    );

function decodedListing(output: string): readonly ListedProcess[] {
    return output
        .split(/\r?\n/)
        .filter((line) => line !== "")
        .map((line) => {
            const listed = LISTED_PROCESS.exec(line);
            if (listed === null) {
                throw new Error("listing the processes gave a line that is not a process");
            }
            return { processId: Number(listed[1]), commandLine: listed[2] ?? "" };
        });
}

function processesNaming(folder: string): Promise<readonly ListedProcess[]> {
    return new Promise((resolve, reject) => {
        const listing = spawn(
            powerShellPath(),
            ["-NoProfile", "-NonInteractive", "-Command", LISTING_COMMAND],
            {
                stdio: ["ignore", "pipe", "ignore"],
                windowsHide: true,
                // Node's own option name.
                ["env"]: { ...process.env, [FOLDER_VARIABLE]: folder },
            },
        );
        let output = "";
        const timer = setTimeout(() => {
            listing.kill();
            reject(
                new Error(
                    `listing the processes took longer than ${LISTING_LIMIT_MILLISECONDS} ms`,
                ),
            );
        }, LISTING_LIMIT_MILLISECONDS);
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
                    resolve(decodedListing(output));
                } catch (error) {
                    reject(error instanceof Error ? error : new Error(String(error)));
                }
            } else {
                reject(new Error(`listing the processes exited with code ${String(code)}`));
            }
        });
    });
}

function isRunning(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch (error) {
        // Only a process that is there can refuse to be asked.
        return error instanceof Error && "code" in error && error.code === "EPERM";
    }
}

function endProcess(processId: number): void {
    try {
        process.kill(processId);
    } catch {
        // Already gone, which is what ending it was for; or refused, which shows as it still running.
    }
}

// The ids of what names the folder and still runs once `graceMilliseconds` have passed. A browser's other
// processes go by themselves soon after it, and listing them on the way out says nothing, so they get the
// grace period. A crashpad handler does not go by itself in any time a stop can wait, as it answers to no
// job object and under load outlives the browser by half a minute, holding the folder. It is the browser's
// own and of no use without it, so it is ended here, and counts as left only if that fails. Anything else
// is not known to be the browser's own, so it is left running, and named. Rejects when the system cannot
// say what is running.
export async function windowsProcessesLeft(
    folder: string,
    graceMilliseconds: number,
): Promise<readonly number[]> {
    const listed = await processesNaming(folder);
    for (const { processId, commandLine } of listed) {
        if (commandLine.includes(CRASHPAD_SWITCH)) {
            endProcess(processId);
        }
    }
    const stopWaitingAt = Date.now() + graceMilliseconds;
    let running = listed.map(({ processId }) => processId).filter(isRunning);
    while (running.length > 0 && Date.now() < stopWaitingAt) {
        await pause(CHECK_INTERVAL_MILLISECONDS);
        running = running.filter(isRunning);
    }
    return running;
}
