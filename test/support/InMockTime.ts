// Runs a step in mock time, so a step that waits out its timeout costs nothing, and says how much mock
// time it took. A step that never settles fails the test instead of hanging it.
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

const TICK_MILLISECONDS = 10;
const LONGEST_WAIT_MILLISECONDS = 8000;

export type Timed<Value> = { readonly value: Value; readonly elapsed: number };

export async function inMockTime<Value>(
    context: TestContext,
    start: () => Promise<Value>,
): Promise<Timed<Value>> {
    context.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const progress = { isSettled: false };
    const work = start().finally(() => {
        progress.isSettled = true;
    });
    let elapsed = 0;
    while (!progress.isSettled && elapsed < LONGEST_WAIT_MILLISECONDS) {
        await new Promise((resolve) => {
            setImmediate(resolve);
        });
        context.mock.timers.tick(TICK_MILLISECONDS);
        elapsed += TICK_MILLISECONDS;
    }
    await new Promise((resolve) => {
        setImmediate(resolve);
    });
    assert.ok(progress.isSettled, `the step had not ended after ${elapsed} ms of mock time`);
    return { value: await work, elapsed };
}
