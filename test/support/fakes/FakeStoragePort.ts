import { success, type StoragePort, type StorageArea } from "@revisum/engine";
import { recordCalls, type Recorded } from "./RecordCalls.ts";

const entryKey = (area: StorageArea, origin: string, key: string): string =>
    JSON.stringify([area, origin, key]);

// Web storage that holds what was written to it, and starts empty.
export function fakeStoragePort(overrides: Partial<StoragePort> = {}): Recorded<StoragePort> {
    const entries = new Map<string, string>();
    const defaults: Required<StoragePort> = {
        write: (area, origin, key, value) => {
            entries.set(entryKey(area, origin, key), value);
            return Promise.resolve(success(undefined));
        },
        remove: (area, origin, key) => {
            entries.delete(entryKey(area, origin, key));
            return Promise.resolve(success(undefined));
        },
        read: (area, origin, key) =>
            Promise.resolve(success(entries.get(entryKey(area, origin, key)) ?? null)),
    };
    return recordCalls({ ...defaults, ...overrides });
}
