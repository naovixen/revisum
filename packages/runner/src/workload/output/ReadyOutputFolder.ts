import { chmodSync, mkdirSync } from "node:fs";
import { platform } from "node:os";

// Readies the host output folder: it exists, and the container's user can write into it, which on
// Linux is another uid than the host's.
export function readyOutputFolder(folder: string): boolean {
    try {
        mkdirSync(folder, { recursive: true });
        if (platform() !== "win32") {
            chmodSync(folder, 0o777);
        }
        return true;
    } catch {
        return false;
    }
}
