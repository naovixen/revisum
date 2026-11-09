// An engine that always answers, whatever the one it wraps does. A throw or a rejection becomes the
// answer each method has for "could not say", so no runner has to guard a call to keep what a command
// already did, or to reach its removals; the removals and the short reads are bounded too. Starting a
// container, making a network and running a command keep the time they need.
import { failure, type Failure } from "@revisum/contracts";
import {
    ImageAnswerKind,
    NetworkFailureKind,
    type ContainerEngine,
    type EngineProblem,
} from "./ContainerEngine.ts";
import { withinReadBound } from "./WithinReadBound.ts";

const thrownDetail = (thrown: unknown): string =>
    thrown instanceof Error ? thrown.message : String(thrown);

async function answered<Answer>(
    call: () => Promise<Answer>,
    couldNotSay: (detail: string) => Answer,
): Promise<Answer> {
    try {
        return await call();
    } catch (thrown) {
        return couldNotSay(thrownDetail(thrown));
    }
}

const bounded = <Answer>(
    call: () => Promise<Answer>,
    couldNotSay: (detail: string) => Answer,
): Promise<Answer> => withinReadBound(answered(call, couldNotSay), couldNotSay);

const asProblem = (detail: string): Failure<EngineProblem> => failure({ detail });

export function answeringEngine(engine: ContainerEngine): ContainerEngine {
    return {
        imageId: (reference) =>
            bounded(
                () => engine.imageId(reference),
                (detail) => ({ kind: ImageAnswerKind.Unanswered, problem: { detail } }),
            ),
        createNetwork: (name, options) =>
            answered(
                () => engine.createNetwork(name, options),
                (detail) => failure({ kind: NetworkFailureKind.Failed, detail }),
            ),
        removeNetwork: (name) => bounded(() => engine.removeNetwork(name), asProblem),
        networkGatewayAddress: (network) =>
            bounded(() => engine.networkGatewayAddress(network), asProblem),
        startContainer: (options) => answered(() => engine.startContainer(options), asProblem),
        exec: (containerId, command, environmentNames) =>
            answered(() => engine.exec(containerId, command, environmentNames), asProblem),
        // An unknown is never taken for 'blocked'.
        probeEgress: (containerId, targets) =>
            bounded(
                () => engine.probeEgress(containerId, targets),
                () => "reached",
            ),
        removeContainer: (containerId) =>
            bounded(() => engine.removeContainer(containerId), asProblem),
        imageUser: (reference) => bounded(() => engine.imageUser(reference), asProblem),
        containerAddress: (containerId, network) =>
            bounded(() => engine.containerAddress(containerId, network), asProblem),
    };
}
