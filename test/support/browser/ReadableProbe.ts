import assert from "node:assert/strict";
import type { ElementProbe, ElementsRead } from "@revisum/engine";

// A probe of a page a test expects to be readable. An unreadable page holds nothing else to read, so
// it fails the test here, saying what the page gave instead.
export function readableProbe(probe: ElementProbe): ElementsRead {
    if (typeof probe.count === "string") {
        assert.fail(`the page could not be read: ${probe.count}`);
    }
    return probe;
}
