// Removes what an earlier container of the image left in the output folder, as its own user, in a
// container of the same image with no network and only the output folder. The caller looks for itself
// whether the paths have gone, so nothing here decides the run, and each step that fails is reported.
import { PRODUCT, WORKLOAD_OUTPUT_PATH, type OutputRemoval } from "@revisum/contracts";
import { randomBytes } from "node:crypto";
import type { ContainerEngine } from "../../containers/ContainerEngine.ts";
import { withContainerScope, type ContainerLifetime } from "../../containers/ContainerScope.ts";
import { areMountablePaths } from "../team-container/AreMountablePaths.ts";
import { readyOutputFolder } from "./ReadyOutputFolder.ts";
import { teamImageContainer } from "../team-container/TeamImageContainer.ts";
import type { WorkloadLog } from "../WorkloadRefusal.ts";
import { ImageAnswerKind, MountKind } from "../../containers/ContainerEngine.ts";

const noticeOf =
    (log: WorkloadLog) =>
    (detail: string): void => {
        log({ code: "notice", detail });
    };

type RemovalContext = {
    readonly engine: ContainerEngine;
    readonly root: string;
    readonly log: (detail: string) => void;
    readonly removal: OutputRemoval;
};

// A mode the suite set on its own files could stop even its own user, so that is lifted first.
async function removeInContainer(context: RemovalContext, scope: ContainerLifetime): Promise<void> {
    const { engine, root, log, removal } = context;
    const insideOutput = removal.paths.map((path) => `${WORKLOAD_OUTPUT_PATH}/${path}`);
    const imageUser = await engine.imageUser(removal.image);
    if (!imageUser.ok) {
        log(
            `the host could not remove what an earlier run left (${removal.hostFailure}), and the image's user could not be read: ${imageUser.error.detail}`,
        );
        return;
    }
    const remover = await scope.startContainer(
        teamImageContainer(root, imageUser.value, {
            name: `${PRODUCT.name}-output-removal-${randomBytes(6).toString("hex")}`,
            image: removal.image,
            networks: [],
            workingFolder: WORKLOAD_OUTPUT_PATH,
            environment: { HOME: "/tmp" },
            mounts: [
                {
                    kind: MountKind.Folder,
                    source: removal.outputDirectory,
                    target: WORKLOAD_OUTPUT_PATH,
                    writable: true,
                },
            ],
        }),
    );
    if (!remover.ok) {
        log(
            `the host could not remove what an earlier run left (${removal.hostFailure}), and the container to do it did not start: ${remover.error.detail}`,
        );
        return;
    }
    const steps = [
        { step: "chmod", argv: ["chmod", "-R", "u+rwx", ...insideOutput] },
        { step: "rm", argv: ["rm", "-rf", ...insideOutput] },
    ];
    for (const { step, argv } of steps) {
        const ran = await engine.exec(remover.value, argv);
        if (!ran.ok) {
            log(`${step} could not run in the removal's container: ${ran.error.detail}`);
        } else if (ran.value.exitCode !== 0) {
            log(
                `${step} exited ${ran.value.exitCode} in the removal's container: ${ran.value.stderr.trim()}`,
            );
        }
    }
}

export async function removeFromOutput(
    engine: ContainerEngine,
    root: string,
    workloadLog: WorkloadLog,
    removal: OutputRemoval,
): Promise<void> {
    const log = noticeOf(workloadLog);
    const cannotUseAContainer = (why: string): void => {
        log(
            `the host could not remove what an earlier run left (${removal.hostFailure}), and no container can be used to: ${why}`,
        );
    };
    if (!areMountablePaths(removal.outputDirectory, [root])) {
        cannotUseAContainer("the output folder or repository path cannot be mounted");
        return;
    }
    const answer = await engine.imageId(removal.image);
    if (answer.kind === ImageAnswerKind.Unanswered) {
        cannotUseAContainer(`Docker did not answer: ${answer.problem.detail}`);
        return;
    }
    if (answer.kind === ImageAnswerKind.Absent || answer.id !== removal.image) {
        cannotUseAContainer("the image is not on this host");
        return;
    }
    if (!readyOutputFolder(removal.outputDirectory)) {
        cannotUseAContainer("the output folder cannot be made writable");
        return;
    }
    const context: RemovalContext = { engine, root, log, removal };
    await withContainerScope(
        engine,
        {
            namePrefix: `${PRODUCT.name}-output-removal`,
            networkKinds: [],
            log: (entry) => {
                log(`the removal's container could not be cleaned up: ${entry.detail}`);
            },
        },
        (scope) => removeInContainer(context, scope),
    );
}
