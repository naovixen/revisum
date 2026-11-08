// A page on the fake document ports that holds one element, ready to be acted on: every read answers
// as a healthy page would, unless a test replaces one.
import { guardDetails } from "../../../packages/driver-cdp/src/in-page/GuardDetails.ts";
import {
    actionability,
    whatAClickActivates,
} from "../../../packages/driver-cdp/src/in-page/Actionability.ts";
import { enabledState } from "../../../packages/driver-cdp/src/in-page/EnabledState.ts";
import type { PageFunction } from "../../../packages/driver-cdp/src/page/PageFunction.ts";
import type { PageOperations } from "../../../packages/driver-cdp/src/page/PageOperations.ts";

export const FAKE_PAGE_ELEMENT = "the-element";

export const ACTIONABLE_REPORT = JSON.stringify({
    attached: true,
    visible: true,
    stable: true,
    receivesEvents: true,
    centre: { x: 10, y: 20 },
});

export const GUARD_DETAILS_REPORT = JSON.stringify({
    box: { x: 0, y: 0, width: 10, height: 10 },
    formSubmitName: null,
    linkUrl: null,
    testId: null,
});

type CallForString = PageOperations<string>["callForString"];

// An answer in place of what a page function would give.
export type PageFunctionAnswer = readonly [PageFunction, CallForString];

const answered =
    (text: string): CallForString =>
    () =>
        Promise.resolve(text);

export function elementPageOperations(
    replaced: readonly PageFunctionAnswer[] = [],
): Partial<PageOperations<string>> {
    const answers = new Map<PageFunction, CallForString>([
        [actionability, answered(ACTIONABLE_REPORT)],
        [enabledState, answered("enabled")],
        [guardDetails, answered(GUARD_DETAILS_REPORT)],
        ...replaced,
    ]);
    return {
        callForString: (pageFunction, inputs) =>
            (answers.get(pageFunction) ?? answered("valid"))(pageFunction, inputs),
        callForElements: (pageFunction) =>
            Promise.resolve(pageFunction === whatAClickActivates ? [] : [FAKE_PAGE_ELEMENT]),
    };
}
