import { success, type ExploreDriver } from "@revisum/engine";
import { FAKE_PAGE, FAKE_SNAPSHOT } from "./FakeSession.ts";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A crawl's view of one page that links nowhere.
export function fakeExploreDriver(overrides: Partial<ExploreDriver> = {}): Recorded<ExploreDriver> {
    const defaults: Required<ExploreDriver> = {
        navigate: () => Promise.resolve(success(undefined)),
        page: () => Promise.resolve(FAKE_PAGE),
        accessibilitySnapshot: () => Promise.resolve(FAKE_SNAPSHOT),
        linkTargets: () => Promise.resolve([]),
    };
    return recordCalls({ ...defaults, ...overrides });
}
