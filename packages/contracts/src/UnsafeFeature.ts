// The unsafe plan features a trusted project may turn on. unsafe-plan-features.ts says what each
// gives up.
export const UnsafeFeature = {
    CssLocator: "css-locator",
    XpathLocator: "xpath-locator",
    DomChecks: "dom-checks",
    PageScript: "page-script",
    InlinePageScript: "inline-page-script",
    DatabaseCommand: "database-command",
} as const;
export type UnsafeFeature = (typeof UnsafeFeature)[keyof typeof UnsafeFeature];
export const UNSAFE_FEATURES: readonly UnsafeFeature[] = Object.values(UnsafeFeature);
