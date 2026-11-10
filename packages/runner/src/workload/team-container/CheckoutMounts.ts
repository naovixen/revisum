// The checkout as the team's container sees it.
import { WORKLOAD_CHECKOUT_PATH } from "@revisum/contracts";
import { readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { ContainerMount } from "../../containers/ContainerEngine.ts";
import { isGitFolderName } from "../../containers/RunImageContainer.ts";
import { isSafeInMountArgument } from "./IsSafeInMountArgument.ts";
import type { WorkloadLog } from "../WorkloadRefusal.ts";
import { MountKind } from "../../containers/ContainerEngine.ts";

function checkoutEntries(checkout: string): Dirent[] | null {
    try {
        return readdirSync(checkout, { withFileTypes: true });
    } catch {
        return null;
    }
}

// The checkout's top-level entries as read-only mounts, leaving out .git, links (whose targets could
// lie outside the checkout) and names a mount argument cannot hold. Null when the checkout cannot be read.
export function checkoutMounts(checkout: string, log: WorkloadLog): ContainerMount[] | null {
    const entries = checkoutEntries(checkout);
    if (entries === null) {
        return null;
    }
    const mounts: ContainerMount[] = [];
    for (const entry of entries) {
        if (isGitFolderName(entry.name) || entry.isSymbolicLink()) {
            continue;
        }
        if (!isSafeInMountArgument(entry.name)) {
            log({
                code: "notice",
                detail: "a top-level entry of the checkout has a name Docker cannot mount; it is left out",
            });
            continue;
        }
        if (!entry.isDirectory() && !entry.isFile()) {
            continue;
        }
        mounts.push({
            kind: entry.isDirectory() ? MountKind.Folder : MountKind.File,
            source: join(checkout, entry.name),
            target: `${WORKLOAD_CHECKOUT_PATH}/${entry.name}`,
        });
    }
    return mounts;
}
