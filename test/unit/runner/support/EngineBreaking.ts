// A fake engine one of whose calls breaks: it throws, or rejects, as an adapter that has lost its
// process might, at the call named.
import assert from "node:assert/strict";
import type { ContainerEngine } from "@revisum/runner";
import {
    fakeContainerEngine,
    type FakeContainerEngine,
    type FakeEngineSettings,
} from "./FakeContainerEngine.ts";

export const REASON_IT_BROKE = "the adapter broke";

export const BREAKAGES = ["throws", "rejects"] as const;
export type Breakage = (typeof BREAKAGES)[number];

export type BrokenCall = {
    readonly method: keyof ContainerEngine;
    readonly isBroken?: (parameters: readonly unknown[]) => boolean;
};

export const commandIs =
    (first: string) =>
    (parameters: readonly unknown[]): boolean => {
        const command = parameters[1];
        return Array.isArray(command) && command[0] === first;
    };

export function engineBreaking(
    settings: FakeEngineSettings,
    call: BrokenCall,
    breakage: Breakage,
): FakeContainerEngine {
    const fake = fakeContainerEngine(settings);
    const working: unknown = Reflect.get(fake, call.method);
    assert.ok(typeof working === "function");
    const broken = (...parameters: readonly unknown[]): unknown => {
        if (call.isBroken?.(parameters) === false) {
            return Reflect.apply(working, fake, parameters);
        }
        if (breakage === "throws") {
            throw new Error(REASON_IT_BROKE);
        }
        return Promise.reject(new Error(REASON_IT_BROKE));
    };
    return { ...fake, [call.method]: broken };
}
