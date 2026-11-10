import assert from "node:assert/strict";
import type { PageReadFailure, Result } from "@revisum/engine";

// What a read of the page gave, for a test that counts on it. A read that gave nothing fails the
// test here, saying why.
export function expectRead<Value>(read: Result<Value, PageReadFailure>): Value {
    if (!read.ok) {
        assert.fail(`the page could not be read: ${read.error.code}: ${read.error.detail}`);
    }
    return read.value;
}
