// The two images a workload needs, here and pinned: Revisum's run image, and the team's, which is
// never pulled and must have the id the request pins.
import { success, type Failure, type Result, type WorkloadRequest } from "@revisum/contracts";
import type { ContainerEngine } from "../container-engine.ts";
import { RUN_IMAGE_TAG } from "../run-image.ts";
import { workloadRefused, type WorkloadRefusal } from "./WorkloadRefusal.ts";

// A daemon that does not answer says nothing about whether an image exists.
async function imageAbsent(
    engine: ContainerEngine,
    detail: string,
): Promise<Failure<WorkloadRefusal>> {
    const unanswered = (await engine.daemonProblem?.()) ?? null;
    return unanswered === null
        ? workloadRefused("image-missing", detail)
        : workloadRefused("workload-start-failed", `Docker did not answer: ${unanswered.detail}`);
}

// The run image's id, once both images are shown to be here.
export async function pinWorkloadImages(
    engine: ContainerEngine,
    request: WorkloadRequest,
): Promise<Result<string, WorkloadRefusal>> {
    const runImage = await engine.imageId(RUN_IMAGE_TAG);
    if (runImage === null) {
        return imageAbsent(engine, `the run image ${RUN_IMAGE_TAG} is not on this host`);
    }
    const teamImage = await engine.imageId(request.image);
    if (teamImage === null) {
        return imageAbsent(engine, "the workload image is not on this host");
    }
    if (teamImage !== request.image) {
        return workloadRefused(
            "image-digest-mismatch",
            "the local workload image has another id than the request pins",
        );
    }
    return success(runImage);
}
