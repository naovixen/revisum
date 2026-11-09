// The two images a workload needs, both here: Revisum's run image, taken as tagged, and the team's,
// which is never pulled and is the only one compared with the id the request pins.
import { success, type Result } from "@revisum/contracts";
import type { ContainerEngine, ImageAnswer } from "../containers/ContainerEngine.ts";
import { RUN_IMAGE_TAG } from "../image/RunImage.ts";
import type { CheckedWorkloadRequest } from "./CheckWorkloadRequest.ts";
import { workloadRefused, type WorkloadRefusal } from "./WorkloadRefusal.ts";

// A daemon that does not answer says nothing about whether an image exists.
function presentImage(answer: ImageAnswer, absent: string): Result<string, WorkloadRefusal> {
    switch (answer.kind) {
        case "found":
            return success(answer.id);
        case "absent":
            return workloadRefused("image-missing", absent);
        case "unanswered":
            return workloadRefused(
                "workload-start-failed",
                `Docker did not answer: ${answer.problem.detail}`,
            );
    }
}

// The run image's id, once both images are shown to be here.
export async function pinWorkloadImages(
    engine: ContainerEngine,
    checked: CheckedWorkloadRequest,
): Promise<Result<string, WorkloadRefusal>> {
    const runImage = presentImage(
        await engine.imageId(RUN_IMAGE_TAG),
        `the run image ${RUN_IMAGE_TAG} is not on this host`,
    );
    if (!runImage.ok) {
        return runImage;
    }
    const teamImage = presentImage(
        await engine.imageId(checked.image),
        "the workload image is not on this host",
    );
    if (!teamImage.ok) {
        return teamImage;
    }
    if (teamImage.value !== checked.image) {
        return workloadRefused(
            "image-digest-mismatch",
            "the local workload image has another id than the request pins",
        );
    }
    return runImage;
}
