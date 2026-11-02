// Which tests a run covers. Every push runs the core tests once; repetition and secondary targets
// run weekly, on demand and at each milestone exit, with REVISUM_TEST_TIER=full. Leak scans, egress,
// approval, policy and every test tools/guarantee-map.ts names stay on push.
import { BrowserTarget } from "./browser/BrowserTarget.ts";

export const TestTier = {
    Push: "push",
    Full: "full",
} as const;

export type TestTier = (typeof TestTier)[keyof typeof TestTier];

const TIER_VARIABLE = "REVISUM_TEST_TIER";

// A mistyped tier fails loudly: read as push, it would pass while running far fewer tests than asked.
export function currentTestTier(): TestTier {
    const asked = process.env[TIER_VARIABLE];
    if (asked === undefined || asked === "") {
        return TestTier.Push;
    }
    const known = Object.values(TestTier).find((tier) => tier === asked);
    if (known === undefined) {
        throw new Error(
            `${TIER_VARIABLE} is "${asked}"; use one of ${Object.values(TestTier).join(", ")}`,
        );
    }
    return known;
}

export const isFullTier = (): boolean => currentTestTier() === TestTier.Full;

// How many times a determinism test repeats its run.
export const determinismRuns = (): number => (isFullTier() ? 20 : 2);

// A test's options when it runs only on the full tier. They hold no skip on the full tier, so a
// skip the test sets for another reason still applies. The reason shows in the push run's report.
export const fullTierOnly = (reason: string): { readonly skip?: string } =>
    isFullTier() ? {} : { skip: `full tier only (${TIER_VARIABLE}=full): ${reason}` };

// Whether this target's tests run on this tier: the headless shell repeats Chrome for Testing's.
export const isTargetRunning = (targetId: string): boolean =>
    isFullTier() || targetId !== BrowserTarget.HeadlessShell;

// A test's options for running on a target.
export const onTarget = (targetId: string): { readonly skip?: string } =>
    isTargetRunning(targetId)
        ? {}
        : fullTierOnly("the headless shell repeats what the Chrome for Testing test proves");
