// Removes what an earlier container of the image left in the output folder, as its own user, in a
// container of the same image with no network and only the output folder.
import { PRODUCT, WORKLOAD_OUTPUT_PATH, type OutputRemoval } from "@revisum/contracts";
import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import type { ContainerEngine } from "../container-engine.ts";
import { isSafeInMountArgument } from "./IsSafeInMountArgument.ts";
import { readyOutputFolder } from "./ReadyOutputFolder.ts";
import { teamImageContainer } from "./TeamImageContainer.ts";
import type { WorkloadLog } from "./WorkloadRefusal.ts";

// A mode the suite set on its own files could stop even its own user, so that is lifted first.
// Neither command's outcome is read, since the caller looks for itself, and an image that lacks them
// fails safe as a folder still there.
export async function removeFromOutput(
    engine: ContainerEngine,
    root: string,
    log: WorkloadLog,
    removal: OutputRemoval,
): Promise<void> {
    const { image, outputDirectory, paths, hostFailure } = removal;
    if (
        !isAbsolute(outputDirectory) ||
        !isSafeInMountArgument(outputDirectory) ||
        !isSafeInMountArgument(root) ||
        (await engine.imageId(image)) !== image ||
        !readyOutputFolder(outputDirectory)
    ) {
        log({
            code: "notice",
            detail: `the host could not remove what an earlier run left (${hostFailure}), and no container can be used to`,
        });
        return;
    }
    const insideOutput = paths.map((path) => `${WORKLOAD_OUTPUT_PATH}/${path}`);
    const imageUser = (await engine.imageUser?.(image)) ?? null;
    const remover = await engine.startContainer(
        teamImageContainer(root, imageUser, {
            name: `${PRODUCT.name}-output-removal-${randomBytes(6).toString("hex")}`,
            image,
            networks: [],
            workingFolder: WORKLOAD_OUTPUT_PATH,
            environment: { HOME: "/tmp" },
            mounts: [
                {
                    kind: "folder",
                    source: outputDirectory,
                    target: WORKLOAD_OUTPUT_PATH,
                    writable: true,
                },
            ],
        }),
    );
    if (!remover.ok) {
        log({
            code: "notice",
            detail: `the host could not remove what an earlier run left (${hostFailure}), and the container to do it did not start: ${remover.error.detail}`,
        });
        return;
    }
    try {
        await engine.exec(remover.value, ["chmod", "-R", "u+rwx", ...insideOutput]);
        await engine.exec(remover.value, ["rm", "-rf", ...insideOutput]);
    } finally {
        await engine.removeContainer(remover.value);
    }
}
