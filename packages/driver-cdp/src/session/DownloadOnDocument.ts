// A download step: the click, guarded as any click, with the browser armed, just before the press,
// to save the one download it starts. A popup the click opens, or a download that is not its own,
// fails the step with unsupported-step and nothing of it is kept.
import {
    failure,
    type ActionGuard,
    type DownloadedFile,
    type DriverError,
    type ResolvedDownloadStep,
    type Result,
} from "@revisum/contracts";
import { actBeforePress } from "./ActOnDocument.ts";
import { failureOfThrow, SELECTOR_INVALID, type DocumentScope } from "./DocumentScope.ts";
import { rejectsSelector } from "./FindElements.ts";
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
    try {
        if (await rejectsSelector(operations, locator)) {
            return failure(SELECTOR_INVALID);
        }
    } catch (error) {
        return failure(failureOfThrow(scope, error));
    }
    const openingsBefore = events.unsupportedOpenings();
    const hasOpenedAnother = (): boolean => events.unsupportedOpenings() > openingsBefore;
    const armed = scope.details.downloads.arm();
    let isKept = false;
    try {
        const clicked = await actBeforePress(
            scope,
            { type: "click", locator },
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
                code: "unsupported-step",
                detail: "something other than the click started a file, or the click opened a popup, a second page or a second download",
            });
        }
        isKept = saved.ok;
        return saved;
    } finally {
        await armed.release(isKept);
    }
}
