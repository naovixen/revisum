// A count of two or more elements, for a fake that reads several. The real check makes the brand, so
// a test can't claim a count the driver's own type would refuse.
import assert from "node:assert/strict";
import { isSeveralElements, type SeveralElements } from "@revisum/engine";

export function severalElements(count: number): SeveralElements {
    assert.ok(isSeveralElements(count), `${count} is several elements`);
    return count;
}
