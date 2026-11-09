// The runner's own short reads, each with a limit of its own, so one that never answers still reaches
// the run's removal. A command the caller asked for is not a read, and runs for as long as it does.
import { failure, type ExecOutcome, type Result } from "@revisum/contracts";
import {
    DOCKER_COMMAND_TIMEOUT_MILLISECONDS,
    type ContainerEngine,
    type EngineProblem,
} from "./ContainerEngine.ts";

const UNANSWERED_DETAIL = `Docker did not answer within ${DOCKER_COMMAND_TIMEOUT_MILLISECONDS} milliseconds`;

export async function withinReadBound<Answer>(
    answer: Promise<Answer>,
    unanswered: (detail: string) => Answer,
): Promise<Answer> {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<Answer>((resolve) => {
        handle = setTimeout(() => {
            resolve(unanswered(UNANSWERED_DETAIL));
        }, DOCKER_COMMAND_TIMEOUT_MILLISECONDS);
    });
    try {
        return await Promise.race([answer, elapsed]);
    } finally {
        clearTimeout(handle);
    }
}

// A command the runner runs for its own purposes, such as reading the proxy's records.
export const readInContainer = (
    engine: ContainerEngine,
    containerId: string,
    command: readonly string[],
): Promise<Result<ExecOutcome, EngineProblem>> =>
    withinReadBound(engine.exec(containerId, command), (detail) => failure({ detail }));
