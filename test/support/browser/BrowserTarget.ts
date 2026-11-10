// The two targets of the own CDP driver: the same driver with a different executable. This file
// imports no browser, so a test that only names a target is not counted as a browser test.

export const BrowserTarget = {
    Chrome: "cdp-chromium",
    HeadlessShell: "cdp-chromium-headless-shell",
} as const;

export type BrowserTarget = (typeof BrowserTarget)[keyof typeof BrowserTarget];

export const DriverAdapter = {
    Cdp: "cdp",
    CdpHeadlessShell: "cdp-headless-shell",
} as const;

export type DriverAdapter = (typeof DriverAdapter)[keyof typeof DriverAdapter];

export const ADAPTER_OF_TARGET: Readonly<Record<BrowserTarget, DriverAdapter>> = {
    [BrowserTarget.Chrome]: DriverAdapter.Cdp,
    [BrowserTarget.HeadlessShell]: DriverAdapter.CdpHeadlessShell,
};

// English, so the engine's built-in English irreversible patterns apply to the runtime guard.
const ENGLISH_DESKTOP = {
    device: "desktop-1280",
    locale: "en-GB",
    timezone: "Europe/London",
    colorScheme: "light",
    reducedMotion: "reduce",
} as const;

// The rows of a project file's matrix for these targets, in English and London time.
export const englishMatrix = (targets: readonly BrowserTarget[]) =>
    targets.map((target) => ({
        id: target,
        adapter: ADAPTER_OF_TARGET[target],
        engine: "chromium",
        ...ENGLISH_DESKTOP,
    }));
