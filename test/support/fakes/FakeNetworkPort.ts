import { success, type NetworkPort } from "@revisum/engine";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

// A network port that has seen no exchanges and given no stub answers, and accepts every stub and
// observation. It knows only what it has recorded, as the real one does.
export function fakeNetworkPort(overrides: Partial<NetworkPort> = {}): Recorded<NetworkPort> {
    const defaults: Required<NetworkPort> = {
        startStub: () => Promise.resolve(success(undefined)),
        stopStub: () => Promise.resolve(success(undefined)),
        stubAnswers: () => [],
        observe: () => Promise.resolve(success(undefined)),
        exchanges: () => [],
        quiet: () => Promise.resolve(success(undefined)),
    };
    return recordCalls({ ...defaults, ...overrides });
}
