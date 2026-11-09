// A download step: the click, guarded as any click, whose selector check is the one every action
// has, with the browser armed, just before the press, to save the one download it starts. A popup the click opens, or a download that is not its own,
// fails the step with unsupported-step and nothing of it is kept.
import {
    DriverErrorCode, StepType, failure,
    type ActionGuard,
    type DownloadedFile,
    type DriverError,
    type ResolvedDownloadStep,
    type Result,
} from "@revisum/contracts";
import type { ArmedDownload } from "../../capabilities/DownloadCapture.ts";
import { actBeforePress } from "./ActOnDocument.ts";
import { failureOfThrow, type DocumentScope } from "../document/DocumentScope.ts";
import { CRASHED } from "./WaitUntilActionable.ts";

export async function downloadOnDocument<Handle>(
    scope: DocumentScope<Handle>,
    step: ResolvedDownloadStep,
    maximumBytes: number,
    guard: ActionGuard,
): Promise<Result<DownloadedFile, DriverError>> {
    const { events, operations } = scope;
    if (events.crashed()) {
        return failure(CRASHED);
    }
    const locator = step.locator;
    const openingsBefore = events.unsupportedOpenings();
    const hasOpenedAnother = (): boolean => events.unsupportedOpenings() > openingsBefore;
    let armed: ArmedDownload;
    try {
        armed = scope.details.downloads.arm();
    } catch (error) {
        return failure(failureOfThrow(scope, error));
    }
    let isKept = false;
    try {
        const clicked = await actBeforePress(
            scope,
            { type: StepType.Click, locator },
            guard,
            async (element, at) => {
                await armed.expectFromPress({
                    frameId: await operations.frameId(),
                    canStartFile: await operations.canPressStartAnything(element, at),
                });
            },
        );
        if (!clicked.ok) {
            return clicked;
        }
        const saved = await armed.finish(
            maximumBytes,
            scope.timeout,
            () => events.crashed() || hasOpenedAnother(),
        );
        if (events.crashed()) {
            return failure(CRASHED);
        }
        if (hasOpenedAnother()) {
            return failure({
                code: DriverErrorCode.UnsupportedStep,
                detail: "something other than the click started a file, or the click opened a popup, a second page or a second download",
            });
        }
        isKept = saved.ok;
        return saved;
    } catch (error) {
        return failure(failureOfThrow(scope, error));
    } finally {
        await armed.release(isKept);
    }
}
