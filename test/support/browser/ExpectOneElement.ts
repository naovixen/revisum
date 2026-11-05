import assert from "node:assert/strict";
import { oneElementOf, type ElementProbe, type OneElementRead } from "@revisum/engine";

// The one element a test expects a probe to have read. Any other probe holds nothing of an element,
// so it fails the test here, saying what the page gave instead.
export function expectOneElement(probe: ElementProbe): OneElementRead {
    const found = oneElementOf(probe);
    if (!found.ok) {
        assert.fail(`the probe read no single element: ${found.error}`);
    }
    return found.value;
}
