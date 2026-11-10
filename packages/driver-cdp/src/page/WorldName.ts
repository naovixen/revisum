// The isolated script worlds the driver makes in each document. The page's own scripts cannot reach
// them, and the browser gives a frame's document one world for each name, so however many reads or
// clicks there are, no more of them are made.
export const WorldName = {
    // Every document is read through this world, so what the page's scripts replace is not what a
    // read calls, and what a read says is not theirs to write. It runs too where the page's own world
    // does not: with the page's scripts turned off, in a document whose own security policy forbids
    // them, and while its timers run on virtual time.
    Reading: "driver-frame",
    // Where click checks live.
    ClickCheck: "driver-click-check",
} as const;
export type WorldName = (typeof WorldName)[keyof typeof WorldName];

// What the click checks' world calls to report a press as it goes, while nothing else can be read.
// Only that world has the binding, so the page's scripts cannot call it.
export const PRESS_REPORT_BINDING = "driverPressReport";
